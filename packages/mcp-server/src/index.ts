export { AulaContext, type AulaContextOptions } from './aula-context.ts';
export {
  buildDiscoverManifest,
  type DiscoveredCapability,
  type DiscoveredChild,
  type DiscoverManifest,
} from './discover.ts';
export {
  type AuthState,
  type AuthStore,
  emptyAuthState,
  FileAuthStore,
  MemoryAuthStore,
  type RevokeSummary,
  revokeAuthState,
} from './mcp-auth.ts';
export { registerTools } from './tools.ts';
