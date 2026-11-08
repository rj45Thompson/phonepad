#include "PhonePadSubsystem.h"
#include "PhonePadModule.h"
#include "PhonePadSettings.h"
#include "Debug/DebugDrawService.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Engine/Texture2D.h"
#include "CanvasItem.h"
#include "HAL/PlatformTime.h"

void UPhonePadSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	const TSharedPtr<FPhonePadRoom> Room = FPhonePadModule::GetRoom();
	if (!Room.IsValid()) return;
	JoinedHandle = Room->OnJoined.AddLambda([this](int32 Seat) { OnPhoneJoined.Broadcast(Seat); });
	LeftHandle = Room->OnLeft.AddLambda([this](int32 Seat) { OnPhoneLeft.Broadcast(Seat); });
	if (GetDefault<UPhonePadSettings>()->bStartWithGame) Start();
	if (GetDefault<UPhonePadSettings>()->bShowJoinOverlay)
		DrawHandle = UDebugDrawService::Register(TEXT("Game"), FDebugDrawDelegate::CreateUObject(this, &UPhonePadSubsystem::DrawOverlay));
}

void UPhonePadSubsystem::Deinitialize()
{
	if (DrawHandle.IsValid()) UDebugDrawService::Unregister(DrawHandle);
	if (const TSharedPtr<FPhonePadRoom> Room = FPhonePadModule::GetRoom())
	{
		Room->OnJoined.Remove(JoinedHandle);
		Room->OnLeft.Remove(LeftHandle);
		if (bStarted) Room->Stop();
	}
	Super::Deinitialize();
}

bool UPhonePadSubsystem::Start()
{
	const TSharedPtr<FPhonePadRoom> Room = FPhonePadModule::GetRoom();
	const UPhonePadSettings* S = GetDefault<UPhonePadSettings>();
	bStarted = Room.IsValid() && Room->Start(S->RelayUrl, S->Layout, S->Seats, S->Labels);
	return bStarted;
}

void UPhonePadSubsystem::Stop()
{
	if (const TSharedPtr<FPhonePadRoom> Room = FPhonePadModule::GetRoom()) Room->Stop();
	bStarted = false;
}

FString UPhonePadSubsystem::GetRoomCode() const { const TSharedPtr<FPhonePadRoom> R = FPhonePadModule::GetRoom(); return R ? R->GetCode() : FString(); }
FString UPhonePadSubsystem::GetJoinUrl() const { const TSharedPtr<FPhonePadRoom> R = FPhonePadModule::GetRoom(); return R ? R->GetJoinUrl() : FString(); }
FString UPhonePadSubsystem::GetStatus() const { const TSharedPtr<FPhonePadRoom> R = FPhonePadModule::GetRoom(); return R ? R->GetStatus() : TEXT("the PhonePad module is not loaded"); }

bool UPhonePadSubsystem::IsPhoneConnected(int32 Seat) const
{
	const TSharedPtr<FPhonePadRoom> R = FPhonePadModule::GetRoom();
	return R && Seat >= 0 && Seat < R->GetSeatCount() && R->IsLive(Seat, FPlatformTime::Seconds());
}

int32 UPhonePadSubsystem::GetPhoneCount() const
{
	int32 N = 0;
	if (const TSharedPtr<FPhonePadRoom> R = FPhonePadModule::GetRoom())
		for (int32 I = 0; I < R->GetSeatCount(); ++I) N += R->IsLive(I, FPlatformTime::Seconds()) ? 1 : 0;
	return N;
}

float UPhonePadSubsystem::GetRoundTripMs(int32 Seat) const
{
	const TSharedPtr<FPhonePadRoom> R = FPhonePadModule::GetRoom();
	return (R && Seat >= 0 && Seat < R->GetSeatCount()) ? (float)R->GetSeat(Seat).RoundTripMs : -1.f;
}

void UPhonePadSubsystem::Rumble(int32 Seat, int32 Milliseconds)
{
	if (const TSharedPtr<FPhonePadRoom> R = FPhonePadModule::GetRoom()) R->Rumble(Seat, Milliseconds);
}

UTexture2D* UPhonePadSubsystem::GetJoinQrTexture()
{
	const TSharedPtr<FPhonePadRoom> R = FPhonePadModule::GetRoom();
	if (!R || !R->IsOpen()) return nullptr;
	if (QrTexture && QrTextureCode == R->GetCode()) return QrTexture;
	const int32 N = R->GetQrSize(), Quiet = 4, Size = N + Quiet * 2;   // a scanner needs the 4-module white border
	const FString& Bits = R->GetQrBits();
	UTexture2D* Tex = UTexture2D::CreateTransient(Size, Size, PF_B8G8R8A8);
	Tex->Filter = TF_Nearest;
	Tex->SRGB = true;
	TArray<FColor> Pixels;
	Pixels.Init(FColor::White, Size * Size);
	for (int32 Row = 0; Row < N; ++Row)
		for (int32 Col = 0; Col < N; ++Col)
			if (Bits[Row * N + Col] == TEXT('1')) Pixels[(Row + Quiet) * Size + Col + Quiet] = FColor::Black;
	FTexture2DMipMap& Mip = Tex->GetPlatformData()->Mips[0];
	void* Data = Mip.BulkData.Lock(LOCK_READ_WRITE);
	FMemory::Memcpy(Data, Pixels.GetData(), Pixels.Num() * sizeof(FColor));
	Mip.BulkData.Unlock();
	Tex->UpdateResource();
	QrTexture = Tex;
	QrTextureCode = R->GetCode();
	return QrTexture;
}

void UPhonePadSubsystem::DrawOverlay(UCanvas* Canvas, APlayerController* PC)
{
	const TSharedPtr<FPhonePadRoom> R = FPhonePadModule::GetRoom();
	if (!R || !Canvas || GetPhoneCount() > 0) return;     // shown only while no phone is playing
	const float Scale = FMath::Max(1.f, Canvas->ClipY / 1080.f);
	const float Pad = 16.f * Scale, Side = 220.f * Scale;
	const float X = Canvas->ClipX - Side - Pad * 2.f, Y = Canvas->ClipY - Side - Pad * 2.f - 70.f * Scale;
	FCanvasTileItem Back(FVector2D(X - Pad, Y - Pad), FVector2D(Side + Pad * 2.f, Side + Pad * 2.f + 70.f * Scale), FLinearColor(0.02f, 0.03f, 0.05f, 0.85f));
	Back.BlendMode = SE_BLEND_Translucent;
	Canvas->DrawItem(Back);
	UFont* Font = GEngine->GetMediumFont();
	Canvas->SetDrawColor(FColor::White);
	if (UTexture2D* Qr = GetJoinQrTexture())
	{
		FCanvasTileItem Tile(FVector2D(X, Y), Qr->GetResource(), FVector2D(Side, Side), FLinearColor::White);
		Tile.BlendMode = SE_BLEND_Opaque;
		Canvas->DrawItem(Tile);
		Canvas->DrawText(Font, TEXT("Scan with your phone to play"), X, Y + Side + 8.f * Scale, Scale, Scale);
		FString Host = R->GetJoinUrl();               // https://relay.example/#CODE -> relay.example
		Host.RemoveFromStart(TEXT("https://"));
		int32 Hash = INDEX_NONE;
		if (Host.FindChar(TEXT('#'), Hash)) Host.LeftInline(Hash);
		Host.RemoveFromEnd(TEXT("/"));
		Canvas->DrawText(Font, FString(TEXT("or open ")) + Host, X, Y + Side + 28.f * Scale, Scale, Scale);
		Canvas->DrawText(Font, FString(TEXT("and type ")) + R->GetCode(), X, Y + Side + 48.f * Scale, Scale * 1.3f, Scale * 1.3f);
	}
	else
	{
		Canvas->DrawText(Font, TEXT("PhonePad: ") + R->GetStatus(), X, Y, Scale, Scale);   // UC-1 alternate 1a: why there is no code
	}
}
