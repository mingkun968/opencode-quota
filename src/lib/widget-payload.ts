import { isPercentEntry, type QuotaToastEntry } from "./entries.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { extractSingleWindowWindowLabel } from "./quota-entry-display.js";
import type { QuotaRenderData } from "./quota-render-data.js";

export const WIDGET_PAYLOAD_VERSION = 1 as const;

/** One quota window row rendered by the desktop overlay. */
export interface WidgetWindow {
  label: string;
  percentRemaining: number;
  /** Unix seconds of the next reset, when the provider reports one. */
  resetAt?: number;
}

/** All displayable windows for one provider. */
export interface WidgetProviderBlock {
  /** Canonical provider id when the snapshot was collected for one provider. */
  id?: string;
  name: string;
  windows: WidgetWindow[];
}

/** Snapshot consumed by `src/widget/overlay.py`. */
export interface WidgetPayload {
  version: typeof WIDGET_PAYLOAD_VERSION;
  /** Unix milliseconds when the snapshot was assembled. */
  generatedAt: number;
  providers: WidgetProviderBlock[];
}

export const DEFAULT_WIDGET_MAX_PROVIDERS = 4;

function stripBrackets(value: string): string {
  return value.replace(/^\[([^\]]+)\]$/u, "$1").trim();
}

function toUnixSeconds(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const milliseconds = new Date(iso).getTime();
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : undefined;
}

function providerNameFor(entry: QuotaToastEntry): string {
  const group = entry.group?.trim();
  if (group) return stripBrackets(formatGroupedHeader(group));

  const bracketed = /^\[([^\]]+)\]/u.exec(entry.name.trim());
  if (bracketed?.[1]) return bracketed[1].trim();

  const windowLabel =
    extractSingleWindowWindowLabel(entry.label ?? "") ?? extractSingleWindowWindowLabel(entry.name);
  if (windowLabel) {
    const stripped = entry.name.replace(windowLabel, "").trim();
    return stripped || entry.name.trim();
  }

  return entry.name.trim();
}

function windowLabelFor(entry: QuotaToastEntry): string {
  const derived =
    extractSingleWindowWindowLabel(entry.label ?? "") ?? extractSingleWindowWindowLabel(entry.name);
  if (derived) return derived;

  const explicit = entry.label?.trim().replace(/:+$/u, "").trim();
  return explicit || entry.name.trim();
}

/**
 * Projects render data (preferably `allWindowsData`) into the overlay payload.
 *
 * Entries are grouped by provider in first-seen order so OpenCode Go renders as
 * `5h`, `Weekly`, and `Monthly` in canonical window order.
 */
export function buildWidgetPayload(params: {
  data: QuotaRenderData | null | undefined;
  nowMs?: number;
  maxProviders?: number;
  /** Tags every block with this canonical id when the snapshot targets one provider. */
  providerId?: string;
}): WidgetPayload {
  const generatedAt = params.nowMs ?? Date.now();
  const providers: WidgetProviderBlock[] = [];
  const byKey = new Map<string, WidgetProviderBlock>();

  for (const entry of params.data?.entries ?? []) {
    if (!isPercentEntry(entry)) continue;

    const name = providerNameFor(entry);
    if (!name) continue;

    const key = name.toLowerCase();
    let block = byKey.get(key);
    if (!block) {
      block = { name, windows: [] };
      byKey.set(key, block);
      providers.push(block);
    }

    const resetAt = toUnixSeconds(entry.resetTimeIso);
    block.windows.push({
      label: windowLabelFor(entry),
      percentRemaining: entry.percentRemaining,
      ...(resetAt !== undefined ? { resetAt } : {}),
    });
  }

  const maxProviders = params.maxProviders ?? DEFAULT_WIDGET_MAX_PROVIDERS;
  const selected = Number.isFinite(maxProviders)
    ? providers.slice(0, Math.max(0, maxProviders))
    : providers;

  return {
    version: WIDGET_PAYLOAD_VERSION,
    generatedAt,
    providers: params.providerId
      ? selected.map((provider) => ({ ...provider, id: params.providerId }))
      : selected,
  };
}
