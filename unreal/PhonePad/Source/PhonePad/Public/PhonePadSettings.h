// PhonePadSettings - the plugin's settings (Project Settings > Plugins > PhonePad, saved in Config/DefaultGame.ini under
// [/Script/PhonePad.PhonePadSettings]). UC-2.2: the relay address is the one thing a developer must set.
#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "PhonePadSettings.generated.h"

UCLASS(Config = Game, DefaultConfig, meta = (DisplayName = "PhonePad"))
class PHONEPAD_API UPhonePadSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	/** Your PhonePad relay, e.g. https://phonepad-relay.<account>.workers.dev (deploy it from the PhonePad repo's relay folder).
	 *  Typed into an .ini by hand it must be in quotes - RelayUrl="https://..." - or Unreal's config reader takes the // for a
	 *  comment and leaves "https:" (measured; the plugin then refuses to start and says so). Project Settings writes the quotes. */
	UPROPERTY(Config, EditAnywhere, Category = "Relay")
	FString RelayUrl;

	/** What the phones show: "pad" (stick, ABXY, shoulders, triggers, Back, Start) or "drive" (pedals, tilt or on-screen steering). */
	UPROPERTY(Config, EditAnywhere, Category = "Controller")
	FString Layout = TEXT("pad");

	/** How many phones may join, 1-8. Phone N drives local player N (controller id N). */
	UPROPERTY(Config, EditAnywhere, Category = "Controller", meta = (ClampMin = "1", ClampMax = "8"))
	int32 Seats = 4;

	/** Names shown on the phone's buttons, keyed b0-b16 by the W3C standard gamepad index (b0 = A, b4 = left shoulder, ...).
	 *  In the drive layout these are the only buttons shown besides the pedals. */
	UPROPERTY(Config, EditAnywhere, Category = "Controller")
	TMap<FString, FString> Labels;

	/** Open a room as soon as the game starts (each game instance). Off: call UPhonePadSubsystem::Start yourself. */
	UPROPERTY(Config, EditAnywhere, Category = "Behaviour")
	bool bStartWithGame = true;

	/** Draw the QR code and room code over the game until the first phone joins (and while no phone is joined). */
	UPROPERTY(Config, EditAnywhere, Category = "Behaviour")
	bool bShowJoinOverlay = true;

	virtual FName GetCategoryName() const override { return TEXT("Plugins"); }
};
