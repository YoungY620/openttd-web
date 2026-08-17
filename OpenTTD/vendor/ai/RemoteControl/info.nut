/*
 * RemoteControl — a placeholder AI that performs no actions of its own.
 *
 * It exists so that an external controller (the in-browser Kimi AI panel,
 * via the em_openttd_action WASM bridge) can create and drive companies
 * in agent-vs-agent battles. The bridge issues commands in this company's
 * context while the script itself simply sleeps.
 */
class RemoteControl extends AIInfo
{
	function GetAuthor()      { return "OpenTTD Web"; }
	function GetName()        { return "RemoteControl"; }
	function GetShortName()   { return "RMCT"; }
	function GetDescription() { return "Externally controlled company for browser AI-agent battles. Does nothing on its own."; }
	function GetVersion()     { return 1; }
	function GetDate()        { return "2026-08-17"; }
	function CreateInstance() { return "RemoteControl"; }
	function GetAPIVersion()  { return "16"; }
}

RegisterAI(RemoteControl());
