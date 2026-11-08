// FPhonePadModule - registers PhonePad as an input device module. The engine asks every such module for its device on the
// first frame it polls gamepads (WindowsApplication.cpp PollGameDeviceState), so the plugin loads at the Default phase.
// The room lives here, for the module's life; the device and the subsystem both work on it.
#include "PhonePadModule.h"
#include "PhonePadDevice.h"
#include "Features/IModularFeatures.h"
#include "Modules/ModuleManager.h"

void FPhonePadModule::StartupModule()
{
	Room = MakeShared<FPhonePadRoom>();
	IInputDeviceModule::StartupModule();          // registers the modular feature the platform application looks for
}

void FPhonePadModule::ShutdownModule()
{
	if (Room.IsValid()) Room->Stop();
	IModularFeatures::Get().UnregisterModularFeature(GetModularFeatureName(), this);
}

TSharedPtr<IInputDevice> FPhonePadModule::CreateInputDevice(const TSharedRef<FGenericApplicationMessageHandler>& InHandler)
{
	return MakeShared<FPhonePadDevice>(InHandler, Room.ToSharedRef());
}

TSharedPtr<FPhonePadRoom> FPhonePadModule::GetRoom()
{
	FPhonePadModule* M = FModuleManager::GetModulePtr<FPhonePadModule>(TEXT("PhonePad"));
	return M ? M->Room : nullptr;
}

IMPLEMENT_MODULE(FPhonePadModule, PhonePad)
