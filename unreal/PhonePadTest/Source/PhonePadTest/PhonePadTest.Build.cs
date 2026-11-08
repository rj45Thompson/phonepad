using UnrealBuildTool;

public class PhonePadTest : ModuleRules
{
	public PhonePadTest(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "InputCore", "Slate", "SlateCore", "ApplicationCore", "PhonePad" });
	}
}
