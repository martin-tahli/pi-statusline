import type { ProviderConfiguration } from "../schema.ts";

/**
 * Minimal view of a model the registry exposes. Only `provider` is required; the
 * rest is passed through so capability derivation can inspect endpoints/reasoning.
 */
export interface DiscoveredModel {
  provider: string;
  id?: string;
  baseUrl?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

/**
 * Pi 0.80.7 ModelRegistry surface used by discovery. Only `getAvailable()` is
 * required; every other method is feature-detected with `typeof` and may be
 * absent (R11). UI/capability code must not assume any optional method exists.
 */
export interface ModelRegistryLike {
  getAvailable(): Array<DiscoveredModel | { provider: string }>;
  getRegisteredProviderIds?(): string[];
  getProviderDisplayName?(id: string): string | undefined;
  getProviderAuthStatus?(id: string): unknown;
  getProvider?(id: string): unknown;
}

export type ProviderProvenance = "available" | "active" | "stored" | "registered";

/** A reconciled provider entry: one row per unique provider id. */
export interface ProviderDescriptor {
  id: string;
  displayName: string;
  provenance: ProviderProvenance[];
  available: boolean;
  authenticated: boolean;
  models: DiscoveredModel[];
}

export interface DiscoveryOptions {
  /** Provider id of the currently active model, if any. */
  activeProvider?: string;
  /** Persisted saved order (stable across refresh/reopen). */
  storedProviders?: readonly string[];
  /** Per-provider stored config, to know which stored ids are real (vs junk). */
  storedRecords?: Readonly<Record<string, ProviderConfiguration>>;
  /** Extension-registered provider ids, when the registry exposes them. */
  registeredProviders?: readonly string[];
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Coerce a registry model entry into our DiscoveredModel shape. */
function toDiscoveredModel(entry: unknown): DiscoveredModel | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const model = entry as Record<string, unknown>;
  const provider = model.provider;
  if (!isNonEmpty(provider)) return undefined;
  return {
    provider,
    ...(typeof model.id === "string" && model.id ? { id: model.id } : {}),
    ...(typeof model.baseUrl === "string" && model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
    ...(typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
      ? { contextWindow: model.contextWindow }
      : {}),
  };
}

/** Resolve auth via the optional registry method; default to "available => authenticated". */
function resolveAuth(registry: ModelRegistryLike, id: string, available: boolean): boolean {
  if (typeof registry.getProviderAuthStatus === "function") {
    try {
      const status = registry.getProviderAuthStatus(id);
      if (typeof status === "boolean") return status;
      if (status && typeof status === "object") {
        const authenticated = (status as Record<string, unknown>).authenticated;
        if (typeof authenticated === "boolean") return authenticated;
      }
    } catch {
      // Feature-detection contract: an optional method that throws is treated as absent.
    }
  }
  return available;
}

/**
 * Dedupe `getAvailable()` by provider, then reconcile with the active provider,
 * stored providers (saved order + records), and extension-registered providers.
 *
 * Stable order: saved order is preserved; providers not in saved order are appended
 * in discovery order (available first, then registered, then active-only). Unknown
 * stored providers with no record and no availability are dropped (junk), but stored
 * providers WITH a saved record are retained even when temporarily unavailable.
 */
export function discoverProviders(
  registry: ModelRegistryLike,
  options: DiscoveryOptions = {},
): ProviderDescriptor[] {
  const availableModels = (registry.getAvailable?.() ?? [])
    .map(toDiscoveredModel)
    .filter((m): m is DiscoveredModel => m !== undefined);

  // Dedupe by provider, preserving first-seen order of models.
  const byProvider = new Map<string, DiscoveredModel[]>();
  for (const model of availableModels) {
    const list = byProvider.get(model.provider);
    if (list) list.push(model);
    else byProvider.set(model.provider, [model]);
  }

  const activeProvider = isNonEmpty(options.activeProvider) ? options.activeProvider : undefined;
  const storedOrder = (options.storedProviders ?? []).filter(isNonEmpty);
  const storedRecords = options.storedRecords ?? {};
  const registered = (options.registeredProviders ?? []).filter(isNonEmpty);

  // Union of all known provider ids.
  const allIds = new Set<string>([
    ...byProvider.keys(),
    ...storedOrder,
    ...Object.keys(storedRecords),
    ...registered,
    ...(activeProvider ? [activeProvider] : []),
  ]);

  const order: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  };
  // 1. Saved order first (stable across refresh/reopen).
  for (const id of storedOrder) push(id);
  // 2. Newly available/registered not in saved order, in discovery order.
  for (const id of byProvider.keys()) push(id);
  for (const id of registered) push(id);
  // 3. Active-only provider last (if somehow not already included).
  if (activeProvider) push(activeProvider);
  // 4. Any stored-record ids not yet ordered (e.g. reordered saved state).
  for (const id of Object.keys(storedRecords)) push(id);

  return order
    .filter((id) => allIds.has(id))
    .map((id) => {
      const models = byProvider.get(id) ?? [];
      const available = models.length > 0;
      const provenance: ProviderProvenance[] = [];
      if (available) provenance.push("available");
      if (storedOrder.includes(id) || id in storedRecords) provenance.push("stored");
      if (registered.includes(id)) provenance.push("registered");
      if (activeProvider === id) provenance.push("active");

      // Drop junk: a stored id with no record, no availability, not active, not registered.
      if (
        !available &&
        !(id in storedRecords) &&
        activeProvider !== id &&
        !registered.includes(id)
      ) {
        return undefined;
      }

      let displayName = id;
      if (typeof registry.getProviderDisplayName === "function") {
        try {
          const name = registry.getProviderDisplayName(id);
          if (isNonEmpty(name)) displayName = name;
        } catch {
          // Optional method; ignore failures.
        }
      }

      return {
        id,
        displayName,
        provenance,
        available,
        authenticated: resolveAuth(registry, id, available),
        models,
      } satisfies ProviderDescriptor;
    })
    .filter((d): d is ProviderDescriptor => d !== undefined);
}
