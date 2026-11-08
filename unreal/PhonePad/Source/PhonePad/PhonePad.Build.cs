using UnrealBuildTool;

public class PhonePad : ModuleRules
{
	public PhonePad(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "DeveloperSettings" });
		PrivateDependencyModuleNames.AddRange(new[] { "ApplicationCore", "InputCore", "InputDevice", "WebSockets", "Json", "SlateCore", "Slate" });
	}
}
