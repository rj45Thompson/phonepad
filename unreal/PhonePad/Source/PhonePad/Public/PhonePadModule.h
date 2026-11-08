#pragma once

#include "CoreMinimal.h"
#include "IInputDeviceModule.h"
#include "PhonePadRoom.h"

class PHONEPAD_API FPhonePadModule : public IInputDeviceModule
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;
	virtual TSharedPtr<IInputDevice> CreateInputDevice(const TSharedRef<FGenericApplicationMessageHandler>& InHandler) override;

	/** The game's room on the relay; null only before the module has started. */
	static TSharedPtr<FPhonePadRoom> GetRoom();

private:
	TSharedPtr<FPhonePadRoom> Room;
};
