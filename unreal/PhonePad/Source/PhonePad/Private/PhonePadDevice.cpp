#include "PhonePadDevice.h"
#include "GenericPlatform/GenericPlatformInputDeviceMapper.h"
#include "Misc/ConfigCacheIni.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformTime.h"

static TAutoConsoleVariable<int32> CVarPhonePadLogInput(
	TEXT("PhonePad.LogInput"), 0,
	TEXT("1 = log every gamepad event PhonePad raises (seat, key, value), for checking a phone end to end."));

static const FName PhonePadDeviceName(TEXT("PhonePad"));

FPhonePadDevice::FPhonePadDevice(const TSharedRef<FGenericApplicationMessageHandler>& InHandler, TSharedRef<FPhonePadRoom> InRoom)
	: Handler(InHandler), Room(InRoom)
{
	// the engine's own button repeat timing, as Unreal's GameInput reads it (GameInputDeviceProcessor.cpp:68-69);
	// BaseInput.ini sets 0.2 and 0.1. A project that removed both keys gets an error, not a made-up delay.
	if (!GConfig->GetFloat(TEXT("/Script/Engine.InputSettings"), TEXT("InitialButtonRepeatDelay"), InitialRepeat, GInputIni)
		|| !GConfig->GetFloat(TEXT("/Script/Engine.InputSettings"), TEXT("ButtonRepeatDelay"), Repeat, GInputIni))
	{
		UE_LOG(LogPhonePad, Error, TEXT("PhonePad: [/Script/Engine.InputSettings] InitialButtonRepeatDelay / ButtonRepeatDelay are missing from the input config; held buttons will not repeat"));
	}
}

void FPhonePadDevice::Tick(float DeltaTime)
{
	Room->Tick(FPlatformTime::Seconds());
}

void FPhonePadDevice::Connect(int32 Seat)
{
	IPlatformInputDeviceMapper& Mapper = IPlatformInputDeviceMapper::Get();
	FEmitted& E = Emitted[Seat];
	if (!E.DeviceId.IsValid()) E.DeviceId = Mapper.AllocateNewInputDeviceId();   // one device per seat, kept across rejoins
	Mapper.Internal_MapInputDeviceToUser(E.DeviceId, Mapper.GetPlatformUserForUserIndex(Seat), EInputDeviceConnectionState::Connected);
	E.bConnected = true;
	E.State = FPhonePadState(); E.Directions = 0;
}

void FPhonePadDevice::Disconnect(int32 Seat, double Now)
{
	Emit(Seat, FPhonePadState(), Now);            // UC-1.6: release everything held before the device goes
	FEmitted& E = Emitted[Seat];
	// as Epic's own browser-driven gamepads do (PixelStreaming2Input InputDevice.cpp:110): a gone device belongs to no player
	IPlatformInputDeviceMapper& Mapper = IPlatformInputDeviceMapper::Get();
	Mapper.Internal_MapInputDeviceToUser(E.DeviceId, Mapper.GetUserForUnpairedInputDevices(), EInputDeviceConnectionState::Disconnected);
	E.bConnected = false;
}

void FPhonePadDevice::SendControllerEvents()
{
	const double Now = FPlatformTime::Seconds();
	for (int32 Seat = 0; Seat < PhonePad::MaxSeats; ++Seat)
	{
		const bool bJoined = Seat < Room->GetSeatCount() && Room->GetSeat(Seat).bJoined;
		if (bJoined && !Emitted[Seat].bConnected) Connect(Seat);
		if (!bJoined && Emitted[Seat].bConnected) { Disconnect(Seat, Now); continue; }
		if (bJoined) Emit(Seat, Room->GetSeat(Seat).State, Now);
	}
}

void FPhonePadDevice::Emit(int32 Seat, const FPhonePadState& T, double Now)
{
	FEmitted& E = Emitted[Seat];
	IPlatformInputDeviceMapper& Mapper = IPlatformInputDeviceMapper::Get();
	const FPlatformUserId User = Mapper.GetPlatformUserForUserIndex(Seat);
	const FInputDeviceId Device = E.DeviceId;
	FInputDeviceScope Scope(this, PhonePadDeviceName, Seat, TEXT("Phone"));
	const bool bLog = CVarPhonePadLogInput.GetValueOnGameThread() != 0;
	const auto Digital = [&](int32 Slot, FName Key, bool bWas, bool bIs)
	{
		if (Key.IsNone()) return;
		if (bIs && !bWas)
		{
			Handler->OnControllerButtonPressed(Key, User, Device, false);
			E.RepeatAt[Slot] = Now + InitialRepeat;
			if (bLog) UE_LOG(LogPhonePad, Log, TEXT("PhonePad input seat=%d key=%s pressed"), Seat, *Key.ToString());
		}
		else if (!bIs && bWas)
		{
			Handler->OnControllerButtonReleased(Key, User, Device, false);
			if (bLog) UE_LOG(LogPhonePad, Log, TEXT("PhonePad input seat=%d key=%s released"), Seat, *Key.ToString());
		}
		else if (bIs && Repeat > 0.f && Now >= E.RepeatAt[Slot])
		{
			Handler->OnControllerButtonPressed(Key, User, Device, true);
			E.RepeatAt[Slot] = Now + Repeat;
		}
	};
	for (int32 I = 0; I < PhonePad::NumButtons; ++I)
		Digital(I, PhonePad::ButtonKey(I), (E.State.Buttons >> I) & 1, (T.Buttons >> I) & 1);
	const uint32 Dirs = PhonePad::StickDirections(T);
	for (int32 Bit = 0; Bit < 8; ++Bit)
		Digital(PhonePad::NumButtons + Bit, PhonePad::StickDirectionKey(Bit), (E.Directions >> Bit) & 1, (Dirs >> Bit) & 1);

	const auto Analog = [&](FName Key, float Was, float Is)
	{
		// every frame while off centre, and once more on the frame it returns to zero (as Unreal's pads do)
		if (Is != 0.f || Was != 0.f)
		{
			Handler->OnControllerAnalog(Key, User, Device, Is);
			if (bLog && Is != Was) UE_LOG(LogPhonePad, Log, TEXT("PhonePad input seat=%d key=%s value=%.3f"), Seat, *Key.ToString(), Is);
		}
	};
	for (int32 I = 0; I < 4; ++I)
	{
		float Sign = 1.f;
		const FName Key = PhonePad::AxisKey(I, Sign);
		Analog(Key, Sign * E.State.Axes[I], Sign * T.Axes[I]);
	}
	Analog(FGamepadKeyNames::LeftTriggerAnalog, E.State.Triggers[0], T.Triggers[0]);
	Analog(FGamepadKeyNames::RightTriggerAnalog, E.State.Triggers[1], T.Triggers[1]);
	E.State = T;
	E.Directions = Dirs;
}

void FPhonePadDevice::SetChannelValue(int32 ControllerId, FForceFeedbackChannelType ChannelType, float Value)
{
	if (ControllerId < 0 || ControllerId >= PhonePad::MaxSeats) return;
	Channels[ControllerId][(int32)ChannelType] = Value;
	Room->SetRumble(ControllerId, FMath::Max(FMath::Max(Channels[ControllerId][0], Channels[ControllerId][1]), FMath::Max(Channels[ControllerId][2], Channels[ControllerId][3])));
}

void FPhonePadDevice::SetChannelValues(int32 ControllerId, const FForceFeedbackValues& Values)
{
	if (ControllerId < 0 || ControllerId >= PhonePad::MaxSeats) return;
	Room->SetRumble(ControllerId, FMath::Max(FMath::Max(Values.LeftLarge, Values.LeftSmall), FMath::Max(Values.RightLarge, Values.RightSmall)));
}

bool FPhonePadDevice::IsGamepadAttached() const
{
	for (const FEmitted& E : Emitted) if (E.bConnected) return true;
	return false;
}
