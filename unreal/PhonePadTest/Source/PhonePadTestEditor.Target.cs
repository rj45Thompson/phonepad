using UnrealBuildTool;

public class PhonePadTestEditorTarget : TargetRules
{
	public PhonePadTestEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("PhonePadTest");
	}
}
