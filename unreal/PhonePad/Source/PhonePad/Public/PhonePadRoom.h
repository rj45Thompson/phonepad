// FPhonePadRoom - the game's room on the relay (UC-1.1, 1.2, 1.6): the socket, the room code and QR code, and each seat's
// latest pad state as the phone sent it. It runs on the game thread (the WebSockets module calls back there). It knows
// nothing about Unreal input; FPhonePadDevice turns its seats into gamepad events.
#pragma once

#include "CoreMinimal.h"
#include "PhonePadProtocol.h"

class IWebSocket;

DECLARE_LOG_CATEGORY_EXTERN(LogPhonePad, Log, All);

struct FPhonePadSeat
{
	bool bJoined = false;             // a phone holds this seat (relay join .. leave)
	FPhonePadState State;             // its latest pad, neutral when it is silent or gone
	double HeardAt = 0;               // FPlatformTime::Seconds() of its last message
	double RoundTripMs = -1;          // the last ping, game -> relay -> phone -> relay -> game; -1 until measured
	float Rumble = 0.f;               // the strongest force-feedback motor the game set for this seat
	double NextPulseAt = 0;
};

class PHONEPAD_API FPhonePadRoom
{
public:
	static constexpr double SilentSeconds = 2.5;  // a phone sends at least once a second; silence this long = it slept (UC-1.6)

	bool Start(const FString& RelayUrl, const FString& Layout, int32 Seats, const TMap<FString, FString>& Labels);
	void Stop();
	void Tick(double Now);                        // pings, rumble pulses, silent phones

	bool IsOpen() const { return !Code.IsEmpty(); }
	const FString& GetCode() const { return Code; }
	const FString& GetJoinUrl() const { return JoinUrl; }
	const FString& GetStatus() const { return Status; }
	int32 GetQrSize() const { return QrSize; }
	const FString& GetQrBits() const { return QrBits; }
	int32 GetSeatCount() const { return SeatCount; }
	const FPhonePadSeat& GetSeat(int32 I) const { return Seats[I]; }
	bool IsLive(int32 I, double Now) const { return Seats[I].bJoined && Now - Seats[I].HeardAt <= SilentSeconds; }
	void SetRumble(int32 Seat, float Strength);
	void Rumble(int32 Seat, int32 Ms);

	TMulticastDelegate<void(int32 /*Seat*/)> OnJoined;
	TMulticastDelegate<void(int32 /*Seat*/)> OnLeft;
	TMulticastDelegate<void()> OnRoomOpen;

	/** Feeds one relay message in as if it arrived (the socket's handler calls this; tests call it directly). */
	void Receive(const FString& Text, double Now);

private:
	void Send(const FString& Text);
	void Fail(const FString& Why);

	TSharedPtr<IWebSocket> Socket;
	FString HelloText, Code, JoinUrl, Status = TEXT("not started"), QrBits;
	int32 QrSize = 0, SeatCount = 0, NextPingId = 1;
	double NextPingAt = 0;
	TMap<int32, TPair<int32, double>> Pings;      // id -> (seat, sent at)
	FPhonePadSeat Seats[PhonePad::MaxSeats];
};
