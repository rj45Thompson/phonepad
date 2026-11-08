// UPhonePadSubsystem - PhonePad for one game instance (UC-1.1, 1.5, UC-2.3): opens the room when the game starts (when
// bStartWithGame), draws the QR code and room code over the game while no phone has joined (when bShowJoinOverlay), and gives
// Blueprints the room code, who has joined and rumble. Input itself needs none of this: phones arrive as gamepads.
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "PhonePadSubsystem.generated.h"

class UCanvas;
class APlayerController;
class UTexture2D;

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FPhonePadSeatEvent, int32, Seat);

UCLASS()
class PHONEPAD_API UPhonePadSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	/** Opens a room with the settings in Project Settings > Plugins > PhonePad. False (and GetStatus says why) if it cannot start. */
	UFUNCTION(BlueprintCallable, Category = "PhonePad")
	bool Start();

	UFUNCTION(BlueprintCallable, Category = "PhonePad")
	void Stop();

	/** The 4-letter room code, empty until the room is open. */
	UFUNCTION(BlueprintPure, Category = "PhonePad")
	FString GetRoomCode() const;

	/** The address the QR code holds (the relay's page, with the code). */
	UFUNCTION(BlueprintPure, Category = "PhonePad")
	FString GetJoinUrl() const;

	/** What PhonePad is doing, or why it stopped, in plain words. */
	UFUNCTION(BlueprintPure, Category = "PhonePad")
	FString GetStatus() const;

	/** A phone holds this seat (local player Seat) and has been heard from in the last 2.5 s. */
	UFUNCTION(BlueprintPure, Category = "PhonePad")
	bool IsPhoneConnected(int32 Seat) const;

	UFUNCTION(BlueprintPure, Category = "PhonePad")
	int32 GetPhoneCount() const;

	/** The last measured round trip to this seat's phone in ms (game -> relay -> phone -> relay -> game), -1 until measured. */
	UFUNCTION(BlueprintPure, Category = "PhonePad")
	float GetRoundTripMs(int32 Seat) const;

	/** Vibrates the phone in this seat (Android; an iPhone's browser cannot vibrate). Force feedback works too. */
	UFUNCTION(BlueprintCallable, Category = "PhonePad")
	void Rumble(int32 Seat, int32 Milliseconds = 200);

	/** The QR code as a texture (black on white, with its quiet zone), to place in your own UI. */
	UFUNCTION(BlueprintCallable, Category = "PhonePad")
	UTexture2D* GetJoinQrTexture();

	UPROPERTY(BlueprintAssignable, Category = "PhonePad")
	FPhonePadSeatEvent OnPhoneJoined;

	UPROPERTY(BlueprintAssignable, Category = "PhonePad")
	FPhonePadSeatEvent OnPhoneLeft;

private:
	void DrawOverlay(UCanvas* Canvas, APlayerController* PC);

	UPROPERTY(Transient)
	TObjectPtr<UTexture2D> QrTexture;
	FString QrTextureCode;
	FDelegateHandle DrawHandle, JoinedHandle, LeftHandle;
	bool bStarted = false;
};
