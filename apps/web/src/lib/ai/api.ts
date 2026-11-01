import {
  AI_API,
  type AiSignalsBody,
  FACE_MODEL_VERSION,
  type FaceInput,
  type FacesPendingPage,
  type PhotoSignals,
  SIGNALS_VERSION,
  type SignalsPendingPage,
} from '@zephyr/shared/client';
import { api } from '../api';
import { ownerHeader } from '../library';

/**
 * The four routes the background scanner uses (phase 6). Writes name the member the scan was started for
 * (X-Zephyr-Expected-User), so a scan never posts under someone else who has since signed in (409
 * session_changed). The UI's own AI routes (status, jobs, people, credits) are wrapped elsewhere.
 */
const withCursor = (path: string, cursor?: string | null) =>
  cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path;

export const signalsPending = (cursor?: string | null, signal?: AbortSignal) =>
  api<SignalsPendingPage>(withCursor(AI_API.signalsPending, cursor), { signal });

export const postSignals = (photos: PhotoSignals[], owner: string, signal?: AbortSignal) =>
  api<{ ok: true; saved: number }>(AI_API.signals, {
    body: { v: SIGNALS_VERSION, photos } satisfies AiSignalsBody,
    headers: ownerHeader(owner),
    signal,
  });

export const facesPending = (cursor?: string | null, signal?: AbortSignal) =>
  api<FacesPendingPage>(withCursor(AI_API.facesPending, cursor), { signal });

export const postFaces = (
  photos: { id: string; faces: FaceInput[] }[],
  owner: string,
  signal?: AbortSignal,
) =>
  api<{ ok: true; saved: number }>(AI_API.faces, {
    body: { v: FACE_MODEL_VERSION, photos },
    headers: ownerHeader(owner),
    signal,
  });
