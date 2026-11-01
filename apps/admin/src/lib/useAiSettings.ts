import { ADMIN_AI_API, type AdminAiSettingsResult, type AiSettingsPatch } from '@zephyr/shared/client';
import { useCallback } from 'react';
import { api } from './api';
import { reauthenticate, withReauth } from './reauth';
import { useAdminSession } from './session';

/**
 * PATCHes Admin › Zephyr AI settings. Changes that could raise spend need a recent passkey sign-in: on
 * 403 reauth_required the browser asks for the passkey and the save is tried once more.
 */
export function useAiSettingsPatch(): (patch: AiSettingsPatch) => Promise<AdminAiSettingsResult> {
  const { setSession } = useAdminSession();
  return useCallback(
    (patch: AiSettingsPatch) =>
      withReauth(
        () => api<AdminAiSettingsResult>(ADMIN_AI_API.settings, { method: 'PATCH', body: patch }),
        async () => setSession(await reauthenticate()),
      ),
    [setSession],
  );
}
