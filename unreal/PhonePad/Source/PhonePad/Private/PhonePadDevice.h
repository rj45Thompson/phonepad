// FPhonePadDevice - an IInputDevice that turns each seat of the room into an ordinary gamepad for local player N
// (UC-1.3, 1.6): button presses and releases with the engine's own repeat timing, the digital stick directions, and the
// analog sticks and triggers sent every frame while they are off centre, the way Unreal's own pad code does
// (GameInputDeviceProcessor.cpp). The game's input code cannot tell a phone from a pad.
#pragma once

#include "CoreMinimal.h"
#include "IInputDevice.h"
#include "GenericPlatform/GenericApplicationMessageHandler.h"
#include "PhonePadRoom.h"

class FPhonePadDevice : public IInputDevice
{
public:
	FPhonePadDevice(const TSharedRef<FGenericApplicationMessageHandler>& InHandler, TSharedRef<FPhonePadRoom> InRoom);

	virtual void Tick(float DeltaTime) override;
	virtual void SendControllerEvents() override;
	virtual void SetMessageHandler(const TSharedRef<FGenericApplicationMessageHandler>& InHandler) override { Handler = InHandler; }
	virtual bool Exec(UWorld* InWorld, const TCHAR* Cmd, FOutputDevice& Ar) override { return false; }
	virtual void SetChannelValue(int32 ControllerId, FForceFeedbackChannelType ChannelType, float Value) override;
	virtual void SetChannelValues(int32 ControllerId, const FForceFeedbackValues& Values) override;
	virtual bool IsGamepadAttached() const override;

private:
	struct FEmitted                               // what the engine has been told for one seat
	{
		bool bConnected = false;
		FInputDeviceId DeviceId;
		FPhonePadState State;
		uint32 Directions = 0;
		double RepeatAt[PhonePad::NumButtons + 8] = {};
	};
	void Emit(int32 Seat, const FPhonePadState& Target, double Now);
	void Connect(int32 Seat);
	void Disconnect(int32 Seat, double Now);

	TSharedRef<FGenericApplicationMessageHandler> Handler;
	TSharedRef<FPhonePadRoom> Room;
	FEmitted Emitted[PhonePad::MaxSeats];
	float InitialRepeat = 0.f, Repeat = 0.f;
	float Channels[PhonePad::MaxSeats][4] = {};
};
