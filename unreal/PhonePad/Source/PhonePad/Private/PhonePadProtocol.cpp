#include "PhonePadProtocol.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "GenericPlatform/GenericApplicationMessageHandler.h"

bool FPhonePadState::IsNeutral() const
{
	return Buttons == 0 && Axes[0] == 0.f && Axes[1] == 0.f && Axes[2] == 0.f && Axes[3] == 0.f && Triggers[0] == 0.f && Triggers[1] == 0.f;
}

namespace
{
	bool ReadUnitArray(const TSharedPtr<FJsonObject>& O, const TCHAR* Field, int32 Count, float Lo, float* Out)
	{
		const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
		if (!O->TryGetArrayField(Field, Arr) || Arr->Num() != Count) return false;
		for (int32 i = 0; i < Count; ++i)
		{
			double V = 0;
			if (!(*Arr)[i].IsValid() || !(*Arr)[i]->TryGetNumber(V) || V < Lo || V > 1.0) return false;
			Out[i] = (float)V;
		}
		return true;
	}

	FString Write(const TSharedRef<FJsonObject>& O)
	{
		FString S;
		const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> W = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&S);
		FJsonSerializer::Serialize(O, W);
		return S;
	}
}

bool PhonePad::ParseMessage(const FString& Text, FPhonePadMessage& Out, FString& OutWhy)
{
	TSharedPtr<FJsonObject> O;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), O) || !O.IsValid()) { OutWhy = TEXT("not JSON"); return false; }
	FString T;
	if (!O->TryGetStringField(TEXT("t"), T)) { OutWhy = TEXT("no message type"); return false; }
	Out = FPhonePadMessage();
	const bool bHasSeat = O->TryGetNumberField(TEXT("seat"), Out.Seat);
	const auto NeedSeat = [&]() { if (!bHasSeat || Out.Seat < 0 || Out.Seat >= MaxSeats) { OutWhy = T + TEXT(" without a seat 0-7"); return false; } return true; };

	if (T == TEXT("room"))
	{
		const TSharedPtr<FJsonObject>* Qr = nullptr;
		if (!O->TryGetStringField(TEXT("code"), Out.Code) || !O->TryGetStringField(TEXT("join"), Out.JoinUrl) || !O->TryGetObjectField(TEXT("qr"), Qr)
			|| !(*Qr)->TryGetNumberField(TEXT("n"), Out.QrSize) || !(*Qr)->TryGetStringField(TEXT("bits"), Out.QrBits) || Out.QrBits.Len() != Out.QrSize * Out.QrSize)
		{
			OutWhy = TEXT("room without a code, join address or a square QR code"); return false;
		}
		Out.Kind = EPhonePadMessage::Room; return true;
	}
	if (T == TEXT("join")) { if (!NeedSeat()) return false; O->TryGetBoolField(TEXT("rejoin"), Out.bRejoin); Out.Kind = EPhonePadMessage::Join; return true; }
	if (T == TEXT("leave")) { if (!NeedSeat()) return false; Out.Kind = EPhonePadMessage::Leave; return true; }
	if (T == TEXT("pong")) { if (!NeedSeat() || !O->TryGetNumberField(TEXT("id"), Out.PingId)) { OutWhy = TEXT("pong without a seat or id"); return false; } Out.Kind = EPhonePadMessage::Pong; return true; }
	if (T == TEXT("error")) { O->TryGetStringField(TEXT("why"), Out.Why); Out.Kind = EPhonePadMessage::Error; return true; }
	if (T == TEXT("s"))
	{
		if (!NeedSeat()) return false;
		double B = -1;
		if (!O->TryGetNumberField(TEXT("b"), B) || B < 0 || B >= (double)(1u << NumButtons) || B != FMath::FloorToDouble(B)) { OutWhy = TEXT("s: b must be a 17-bit button mask"); return false; }
		Out.State.Buttons = (uint32)B;
		if (!ReadUnitArray(O, TEXT("a"), 4, -1.f, Out.State.Axes)) { OutWhy = TEXT("s: a must be 4 axes in -1..1"); return false; }
		if (!ReadUnitArray(O, TEXT("p"), 2, 0.f, Out.State.Triggers)) { OutWhy = TEXT("s: p must be 2 triggers in 0..1"); return false; }
		Out.Kind = EPhonePadMessage::State; return true;
	}
	OutWhy = TEXT("the relay does not send a host ") + T;
	return false;
}

FString PhonePad::MakeHello(const FString& Layout, int32 Seats, const TMap<FString, FString>& Labels)
{
	const TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
	O->SetStringField(TEXT("t"), TEXT("hello"));
	O->SetStringField(TEXT("layout"), Layout);
	O->SetNumberField(TEXT("seats"), Seats);
	const TSharedRef<FJsonObject> L = MakeShared<FJsonObject>();
	for (const TPair<FString, FString>& P : Labels) L->SetStringField(P.Key, P.Value);
	O->SetObjectField(TEXT("labels"), L);
	return Write(O);
}

FString PhonePad::MakeRumble(int32 Seat, int32 Ms)
{
	const TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
	O->SetStringField(TEXT("t"), TEXT("rumble")); O->SetNumberField(TEXT("seat"), Seat); O->SetNumberField(TEXT("ms"), Ms);
	return Write(O);
}

FString PhonePad::MakePing(int32 Seat, int32 Id)
{
	const TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
	O->SetStringField(TEXT("t"), TEXT("ping")); O->SetNumberField(TEXT("seat"), Seat); O->SetNumberField(TEXT("id"), Id);
	return Write(O);
}

FName PhonePad::ButtonKey(int32 I)
{
	switch (I)                                    // https://w3c.github.io/gamepad/#remapping -> FGamepadKeyNames
	{
	case 0: return FGamepadKeyNames::FaceButtonBottom;
	case 1: return FGamepadKeyNames::FaceButtonRight;
	case 2: return FGamepadKeyNames::FaceButtonLeft;
	case 3: return FGamepadKeyNames::FaceButtonTop;
	case 4: return FGamepadKeyNames::LeftShoulder;
	case 5: return FGamepadKeyNames::RightShoulder;
	case 6: return FGamepadKeyNames::LeftTriggerThreshold;
	case 7: return FGamepadKeyNames::RightTriggerThreshold;
	case 8: return FGamepadKeyNames::SpecialLeft;
	case 9: return FGamepadKeyNames::SpecialRight;
	case 10: return FGamepadKeyNames::LeftThumb;
	case 11: return FGamepadKeyNames::RightThumb;
	case 12: return FGamepadKeyNames::DPadUp;
	case 13: return FGamepadKeyNames::DPadDown;
	case 14: return FGamepadKeyNames::DPadLeft;
	case 15: return FGamepadKeyNames::DPadRight;
	default: return NAME_None;
	}
}

FName PhonePad::AxisKey(int32 I, float& OutSign)
{
	OutSign = (I == 1 || I == 3) ? -1.f : 1.f;
	switch (I)
	{
	case 0: return FGamepadKeyNames::LeftAnalogX;
	case 1: return FGamepadKeyNames::LeftAnalogY;
	case 2: return FGamepadKeyNames::RightAnalogX;
	case 3: return FGamepadKeyNames::RightAnalogY;
	default: return NAME_None;
	}
}

uint32 PhonePad::StickDirections(const FPhonePadState& S)
{
	constexpr float LeftDead = 7849.0f / 32768.0f;   // XINPUT_GAMEPAD_LEFT_THUMB_DEADZONE, as GameInputUtils.h:67
	constexpr float RightDead = 8689.0f / 32768.0f;  // XINPUT_GAMEPAD_RIGHT_THUMB_DEADZONE, as GameInputUtils.h:68
	uint32 Bits = 0;
	const float LY = -S.Axes[1], RY = -S.Axes[3];   // Unreal's Y: up positive
	if (LY > LeftDead) Bits |= 1; else if (LY < -LeftDead) Bits |= 2;
	if (S.Axes[0] < -LeftDead) Bits |= 4; else if (S.Axes[0] > LeftDead) Bits |= 8;
	if (RY > RightDead) Bits |= 16; else if (RY < -RightDead) Bits |= 32;
	if (S.Axes[2] < -RightDead) Bits |= 64; else if (S.Axes[2] > RightDead) Bits |= 128;
	return Bits;
}

FName PhonePad::StickDirectionKey(int32 Bit)
{
	switch (Bit)
	{
	case 0: return FGamepadKeyNames::LeftStickUp;
	case 1: return FGamepadKeyNames::LeftStickDown;
	case 2: return FGamepadKeyNames::LeftStickLeft;
	case 3: return FGamepadKeyNames::LeftStickRight;
	case 4: return FGamepadKeyNames::RightStickUp;
	case 5: return FGamepadKeyNames::RightStickDown;
	case 6: return FGamepadKeyNames::RightStickLeft;
	case 7: return FGamepadKeyNames::RightStickRight;
	default: return NAME_None;
	}
}
