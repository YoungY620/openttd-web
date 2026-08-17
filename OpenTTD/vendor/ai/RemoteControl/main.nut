/*
 * RemoteControl — placeholder AI. All decisions arrive externally through
 * the em_openttd_action WASM bridge; this script just stays alive.
 */
class RemoteControl extends AIController
{
	function Start()
	{
		while (true) {
			this.Sleep(10000);
		}
	}
}
