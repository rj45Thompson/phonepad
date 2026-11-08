#include "PhonePadTestGame.h"
#include "Framework/Application/IInputProcessor.h"
#include "Framework/Application/SlateApplication.h"
#include "Kismet/GameplayStatics.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "TimerManager.h"
#include "Engine/World.h"
#include "Modules/ModuleManager.h"
#include "PhonePadSubsystem.h"

IMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, PhonePadTest, "PhonePadTest");

DEFINE_LOG_CATEGORY_STATIC(LogPhonePadTest, Log, All);

namespace
{
	class FLogGamepadInput : public IInputProcessor   // sees every event Slate gets, before any widget or focus decides
	{
	public:
		virtual void Tick(const float, FSlateApplication&, TSharedRef<ICursor>) override {}
		virtual bool HandleKeyDownEvent(FSlateApplication&, const FKeyEvent& E) override { Log(TEXT("down"), E.GetKey(), E.GetUserIndex(), 1.f, E.IsRepeat()); return false; }
		virtual bool HandleKeyUpEvent(FSlateApplication&, const FKeyEvent& E) override { Log(TEXT("up"), E.GetKey(), E.GetUserIndex(), 0.f, false); return false; }
		virtual bool HandleAnalogInputEvent(FSlateApplication&, const FAnalogInputEvent& E) override
		{
			const FString K = E.GetKey().ToString();
			float& Last = LastAnalog.FindOrAdd(K + FString::FromInt(E.GetUserIndex()), 0.f);
			if (Last != E.GetAnalogValue()) { Last = E.GetAnalogValue(); Log(TEXT("analog"), E.GetKey(), E.GetUserIndex(), Last, false); }
			return false;
		}
		virtual const TCHAR* GetDebugName() const override { return TEXT("PhonePadTestLogger"); }
	private:
		void Log(const TCHAR* What, const FKey& Key, uint32 User, float Value, bool bRepeat)
		{
			if (!Key.IsGamepadKey()) return;
			UE_LOG(LogPhonePadTest, Log, TEXT("TESTSLATE user=%u key=%s %s value=%.3f%s t=%.3f"), User, *Key.ToString(), What, Value, bRepeat ? TEXT(" repeat") : TEXT(""), FPlatformTime::Seconds());
		}
		TMap<FString, float> LastAnalog;
	};
}

bool APhonePadTestController::InputKey(const FInputKeyEventArgs& Params)
{
	if (Params.Key.IsGamepadKey() && (Params.Event != IE_Axis || Params.AmountDepressed != 0.f))
	{
		const ULocalPlayer* LP = GetLocalPlayer();
		UE_LOG(LogPhonePadTest, Log, TEXT("TESTPC player=%d key=%s event=%d amount=%.3f"), LP ? LP->GetLocalPlayerIndex() : -1, *Params.Key.ToString(), (int32)Params.Event, Params.AmountDepressed);
	}
	return Super::InputKey(Params);
}

APhonePadTestGameMode::APhonePadTestGameMode()
{
	PlayerControllerClass = APhonePadTestController::StaticClass();
	DefaultPawnClass = nullptr;
}

void APhonePadTestGameMode::BeginPlay()
{
	Super::BeginPlay();
	UGameplayStatics::CreatePlayer(this, 1, true);   // seat 1's phone drives local player 1
	Logger = MakeShared<FLogGamepadInput>();
	FSlateApplication::Get().RegisterInputPreProcessor(Logger);
	float QuitAfter = 0.f;
	if (FParse::Value(FCommandLine::Get(), TEXT("-PhonePadTestQuitAfter="), QuitAfter) && QuitAfter > 0.f)
		GetWorld()->GetTimerManager().SetTimer(QuitTimer, []() { UE_LOG(LogPhonePadTest, Log, TEXT("TESTDONE")); FPlatformMisc::RequestExit(false); }, QuitAfter, false);
	UE_LOG(LogPhonePadTest, Log, TEXT("TESTREADY players=%d"), UGameplayStatics::GetNumLocalPlayerControllers(this));
	GetWorld()->GetTimerManager().SetTimer(StatusTimer, [this]()   // the plugin's own view: phones live, measured round trips
	{
		const UPhonePadSubsystem* S = GetGameInstance()->GetSubsystem<UPhonePadSubsystem>();
		UE_LOG(LogPhonePadTest, Log, TEXT("TESTSTATUS phones=%d rtt0=%.1f rtt1=%.1f status=%s"), S->GetPhoneCount(), S->GetRoundTripMs(0), S->GetRoundTripMs(1), *S->GetStatus());
	}, 2.f, true);
}

void APhonePadTestGameMode::EndPlay(const EEndPlayReason::Type Reason)
{
	if (Logger.IsValid() && FSlateApplication::IsInitialized()) FSlateApplication::Get().UnregisterInputPreProcessor(Logger);
	Super::EndPlay(Reason);
}
