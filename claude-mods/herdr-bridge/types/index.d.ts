export type HerdrBridgeRequestId = string
export type HerdrBridgeStartedAt = number

declare module 'claude-code' {
  interface PluginState {
    'herdr-bridge': { lastRequestId: HerdrBridgeRequestId; startedAt: HerdrBridgeStartedAt }
  }
}
