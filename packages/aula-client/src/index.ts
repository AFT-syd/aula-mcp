export { AulaClient, type AulaClientOptions } from './aula-client.ts';
export {
  type AulaEnvelope,
  type AulaInstitutionProfile,
  type AulaInstitutionProfileContext,
  type AulaInstitutionRelation,
  type AulaPageConfiguration,
  type AulaProfile,
  type AulaProfileChild,
  type AulaTokenResponse,
  type AulaWidgetConfiguration,
  type CalendarEvent,
  type CalendarLessonParticipant,
  type DailyOverviewEntry,
  type GetCalendarEventsArgs,
  type MessageThread,
  PRESENCE_STATUS,
  type PresenceStatusName,
  type ProfileContextData,
  type ProfilesByLoginData,
  type ThreadMessage,
  type ThreadMessagesData,
  type ThreadsData,
} from './aula-types.ts';
export {
  AulaApiError,
  AulaApiVersionError,
  AulaClientError,
  AulaStepUpRequiredError,
} from './errors.ts';
export {
  isWidgetTokenExpiredResponse,
  type WidgetExpiredSignal,
  WidgetTokenManager,
  type WidgetTokenManagerOptions,
} from './widget-token-manager.ts';
