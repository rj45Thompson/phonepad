// The test game: a game mode with two local players whose controllers log every key the engine hands them, plus a Slate
// input pre-processor that logs every gamepad event reaching Slate at all (focus or not). test/unreal_e2e.mjs plays phones
// against it and reads both logs.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/PlayerController.h"
#include "PhonePadTestGame.generated.h"

UCLASS()
class APhonePadTestController : public APlayerController
{
	GENERATED_BODY()
public:
	virtual bool InputKey(const FInputKeyEventArgs& Params) override;
};

UCLASS()
class APhonePadTestGameMode : public AGameModeBase
{
	GENERATED_BODY()
public:
	APhonePadTestGameMode();
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type Reason) override;
private:
	TSharedPtr<class IInputProcessor> Logger;
	FTimerHandle QuitTimer, StatusTimer;
};
