export type Annotated = { id: string; lines: number[] }

declare module 'claude-code' {
  interface PluginState {
    'plan-annotations': { annotated: Shaped<Annotated[]> }
  }
}
