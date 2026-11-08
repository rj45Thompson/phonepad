// PhonePadProtocol - the relay's messages and the W3C -> Unreal gamepad mapping, as plain code with no engine state, so
// every rule here is testable on its own. The relay's side of the same protocol: relay/src/rules.js.
#pragma once

#include "CoreMinimal.h"

/** One phone's pad, in the W3C "standard" layout the phone sends: 17 buttons as bits, 4 stick axes (Y positive DOWN),
 *  2 analog triggers. */
struct PHONEPAD_API FPhonePadState
{
	uint32 Buttons = 0;
	float Axes[4] = { 0.f, 0.f, 0.f, 0.f };
	float Triggers[2] = { 0.f, 0.f };
	bool IsNeutral() const;
};

enum class EPhonePadMessage : uint8 { Unknown, Room, Join, Leave, State, Pong, Error };

/** A relay message, read. Fields not used by its kind stay at their defaults. */
struct PHONEPAD_API FPhonePadMessage
{
	EPhonePadMessage Kind = EPhonePadMessage::Unknown;
	int32 Seat = -1;
	bool bRejoin = false;
	FPhonePadState State;
	FString Code, JoinUrl, Why;
	int32 QrSize = 0;
	FString QrBits;
	int32 PingId = 0;
};

namespace PhonePad
{
	constexpr int32 NumButtons = 17;
	constexpr int32 MaxSeats = 8;

	/** Reads one message from the relay. False with OutWhy when it is not one the relay sends (never guessed at). */
	PHONEPAD_API bool ParseMessage(const FString& Text, FPhonePadMessage& Out, FString& OutWhy);

	/** The host's first message: { t: "hello", layout, seats, labels }. */
	PHONEPAD_API FString MakeHello(const FString& Layout, int32 Seats, const TMap<FString, FString>& Labels);
	PHONEPAD_API FString MakeRumble(int32 Seat, int32 Ms);
	PHONEPAD_API FString MakePing(int32 Seat, int32 Id);

	/** The Unreal key for W3C standard button I. NAME_None for button 16 (Home/Guide): FGamepadKeyNames has no such key. */
	PHONEPAD_API FName ButtonKey(int32 I);

	/** The Unreal analog key for W3C axis I (0 LeftX, 1 LeftY, 2 RightX, 3 RightY) and the sign that turns the phone's
	 *  value into Unreal's: W3C Y is positive DOWN, Unreal's LeftAnalogY is positive UP (XInput, GameInputDeviceProcessor.cpp:445). */
	PHONEPAD_API FName AxisKey(int32 I, float& OutSign);

	/** The digital stick directions Unreal's own pads raise from the analog sticks (LeftStickUp, ...), with the thresholds
	 *  Unreal reads from XInput (GameInputUtils.h:67-68). Bit order: up, down, left, right for the left stick, then the right. */
	PHONEPAD_API uint32 StickDirections(const FPhonePadState& S);
	PHONEPAD_API FName StickDirectionKey(int32 Bit);
}
