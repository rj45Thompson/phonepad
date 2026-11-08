#include "PhonePadRoom.h"
#include "IWebSocket.h"
#include "WebSocketsModule.h"
#include "Modules/ModuleManager.h"
#include "HAL/PlatformTime.h"

DEFINE_LOG_CATEGORY(LogPhonePad);

bool FPhonePadRoom::Start(const FString& RelayUrl, const FString& Layout, int32 InSeats, const TMap<FString, FString>& Labels)
{
	Stop();
	if (!RelayUrl.StartsWith(TEXT("https://")) && !RelayUrl.StartsWith(TEXT("http://")))
	{
		Fail(FString::Printf(TEXT("RelayUrl must start with https:// (Project Settings > Plugins > PhonePad); it is \"%s\""), *RelayUrl));
		return false;
	}
	if (Layout != TEXT("pad") && Layout != TEXT("drive")) { Fail(TEXT("Layout must be pad or drive, not ") + Layout); return false; }
	if (InSeats < 1 || InSeats > PhonePad::MaxSeats) { Fail(FString::Printf(TEXT("Seats must be 1-%d, not %d"), PhonePad::MaxSeats, InSeats)); return false; }
	SeatCount = InSeats;
	HelloText = PhonePad::MakeHello(Layout, InSeats, Labels);
	FString Url = RelayUrl;
	Url.RemoveFromEnd(TEXT("/"));
	Url = (Url.StartsWith(TEXT("https://")) ? TEXT("wss://") + Url.RightChop(8) : TEXT("ws://") + Url.RightChop(7)) + TEXT("/ws/host");

	Socket = FModuleManager::LoadModuleChecked<FWebSocketsModule>(TEXT("WebSockets")).CreateWebSocket(Url, FString());
	Socket->OnConnected().AddLambda([this]() { Status = TEXT("connected, opening a room"); Send(HelloText); });
	Socket->OnConnectionError().AddLambda([this, Url](const FString& Error) { Fail(FString::Printf(TEXT("could not reach the relay at %s: %s"), *Url, *Error)); });
	Socket->OnClosed().AddLambda([this](int32 StatusCode, const FString& Reason, bool) {
		if (!Code.IsEmpty()) Fail(FString::Printf(TEXT("the relay closed room %s (%d %s)"), *Code, StatusCode, *Reason));
	});
	Socket->OnMessage().AddLambda([this](const FString& Text) { Receive(Text, FPlatformTime::Seconds()); });
	Status = TEXT("connecting to ") + Url;
	UE_LOG(LogPhonePad, Log, TEXT("PhonePad: %s"), *Status);
	Socket->Connect();
	return true;
}

void FPhonePadRoom::Stop()
{
	for (int32 I = 0; I < PhonePad::MaxSeats; ++I)
	{
		if (Seats[I].bJoined) { Seats[I] = FPhonePadSeat(); OnLeft.Broadcast(I); }
		Seats[I] = FPhonePadSeat();
	}
	if (Socket.IsValid())
	{
		Socket->OnClosed().Clear(); Socket->OnMessage().Clear(); Socket->OnConnectionError().Clear(); Socket->OnConnected().Clear();
		if (Socket->IsConnected()) Socket->Close(1000, TEXT("game closed"));
		Socket.Reset();
	}
	Code.Reset(); JoinUrl.Reset(); QrBits.Reset(); QrSize = 0; Pings.Reset();
	Status = TEXT("stopped");
}

void FPhonePadRoom::Fail(const FString& Why)
{
	Status = Why;
	UE_LOG(LogPhonePad, Error, TEXT("PhonePad: %s"), *Why);   // shown on the join overlay too; the room is closed, never half-open
	for (int32 I = 0; I < PhonePad::MaxSeats; ++I) if (Seats[I].bJoined) { Seats[I] = FPhonePadSeat(); OnLeft.Broadcast(I); }
	Code.Reset();
	if (Socket.IsValid() && Socket->IsConnected()) { Socket->OnClosed().Clear(); Socket->Close(1000, TEXT("refused")); }
}

void FPhonePadRoom::Send(const FString& Text)
{
	if (Socket.IsValid() && Socket->IsConnected()) Socket->Send(Text);
}

void FPhonePadRoom::Receive(const FString& Text, double Now)
{
	FPhonePadMessage M;
	FString Why;
	if (!PhonePad::ParseMessage(Text, M, Why)) { Fail(TEXT("the relay sent a message this plugin cannot read (") + Why + TEXT(")")); return; }
	if (M.Seat >= SeatCount && M.Kind != EPhonePadMessage::Room && M.Kind != EPhonePadMessage::Error) { Fail(FString::Printf(TEXT("the relay named seat %d of %d"), M.Seat, SeatCount)); return; }
	switch (M.Kind)
	{
	case EPhonePadMessage::Room:
		Code = M.Code; JoinUrl = M.JoinUrl; QrSize = M.QrSize; QrBits = M.QrBits;
		Status = TEXT("room ") + Code + TEXT(" open at ") + JoinUrl;
		UE_LOG(LogPhonePad, Log, TEXT("PhonePad: room %s open - phones join at %s"), *Code, *JoinUrl);
		OnRoomOpen.Broadcast();
		break;
	case EPhonePadMessage::Join:
		Seats[M.Seat] = FPhonePadSeat(); Seats[M.Seat].bJoined = true; Seats[M.Seat].HeardAt = Now;
		UE_LOG(LogPhonePad, Log, TEXT("PhonePad: player %d joined%s"), M.Seat + 1, M.bRejoin ? TEXT(" again") : TEXT(""));
		OnJoined.Broadcast(M.Seat);
		break;
	case EPhonePadMessage::Leave:
		Seats[M.Seat] = FPhonePadSeat();
		UE_LOG(LogPhonePad, Log, TEXT("PhonePad: player %d left"), M.Seat + 1);
		OnLeft.Broadcast(M.Seat);
		break;
	case EPhonePadMessage::State:
		if (!Seats[M.Seat].bJoined) { Seats[M.Seat].bJoined = true; OnJoined.Broadcast(M.Seat); }
		Seats[M.Seat].State = M.State; Seats[M.Seat].HeardAt = Now;
		break;
	case EPhonePadMessage::Pong:
		if (const TPair<int32, double>* P = Pings.Find(M.PingId)) { Seats[P->Key].RoundTripMs = (Now - P->Value) * 1000.0; Pings.Remove(M.PingId); }
		break;
	case EPhonePadMessage::Error:
		if (Code.IsEmpty()) Fail(TEXT("the relay refused the room: ") + M.Why);
		else UE_LOG(LogPhonePad, Warning, TEXT("PhonePad: the relay reported: %s"), *M.Why);   // e.g. a rumble for a seat that just left
		break;
	default: break;
	}
}

void FPhonePadRoom::Tick(double Now)
{
	if (Code.IsEmpty()) return;
	for (int32 I = 0; I < SeatCount; ++I)
	{
		FPhonePadSeat& S = Seats[I];
		if (S.bJoined && Now - S.HeardAt > SilentSeconds && !S.State.IsNeutral()) S.State = FPhonePadState();   // UC-1.6: the phone slept
		// Force feedback is a level, a phone's vibrate is a duration: while a motor is above 0.1 the phone gets 100 ms pulses.
		if (S.bJoined && S.Rumble > 0.1f && Now >= S.NextPulseAt) { Send(PhonePad::MakeRumble(I, 100)); S.NextPulseAt = Now + 0.1; }
	}
	if (Now >= NextPingAt)
	{
		NextPingAt = Now + 2.0;
		for (int32 I = 0; I < SeatCount; ++I)
		{
			if (!Seats[I].bJoined) continue;
			const int32 Id = NextPingId++;
			Pings.Add(Id, TPair<int32, double>(I, Now));
			Send(PhonePad::MakePing(I, Id));
		}
		if (Pings.Num() > 64) Pings.Reset();      // pongs that never came (a phone that left mid-ping)
	}
}

void FPhonePadRoom::SetRumble(int32 Seat, float Strength)
{
	if (Seat >= 0 && Seat < SeatCount) Seats[Seat].Rumble = Strength;
}

void FPhonePadRoom::Rumble(int32 Seat, int32 Ms)
{
	if (Seat >= 0 && Seat < SeatCount && Seats[Seat].bJoined) Send(PhonePad::MakeRumble(Seat, FMath::Clamp(Ms, 1, 2000)));
}
