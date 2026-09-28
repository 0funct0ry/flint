import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ConfigNotice, ConfigOrigin, FlintConfig } from '../types';
import { api } from '../services/ipc';

const DEFAULT_CONFIG: FlintConfig = {
  version: 1,
  theme: 'system',
  editor: {
    fontSize: 14,
    fontFamily: 'IBM Plex Mono',
    softWrap: true,
    tabSize: 2,
    showLineNumbers: false,
    vimMode: false,
  },
  markdown: {
    math: true,
    tables: true,
    footnotes: true,
    smartPunctuation: true,
  },
  behaviour: {
    autosaveMs: 400,
    rewriteLinksOnRename: true,
    deleteToTrash: true,
    newNoteFolder: '',
    defaultMode: 'edit',
  },
  ui: {
    leftSidebar: 'tree',
    rightSidebarVisible: true,
    showNonNoteFiles: false,
  },
  mcp: {
    enabled: false,
    port: null,
    requireAuth: false,
  },
  ignore: [],
  layout: {},
};

function getAtPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: any = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Immutably sets a dotted-path value in a plain object, returning a new top-level object. */
function setAtPathImmutable<T extends Record<string, unknown>>(obj: T, path: string, value: unknown): T {
  const parts = path.split('.');
  const clone = (node: any): any => (node && typeof node === 'object' && !Array.isArray(node) ? { ...node } : node);
  const root = clone(obj);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = clone(cur[part] ?? {});
    cur[part] = next;
    cur = next;
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

/** Immutably deletes a dotted-path value, returning a new top-level object. */
function deleteAtPathImmutable<T extends Record<string, unknown>>(obj: T, path: string): T {
  const parts = path.split('.');
  const clone = (node: any): any => (node && typeof node === 'object' && !Array.isArray(node) ? { ...node } : node);
  const root = clone(obj);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] === undefined) return root;
    const next = clone(cur[part]);
    cur[part] = next;
    cur = next;
  }
  delete cur[parts[parts.length - 1]];
  return root;
}

export interface SettingsContextValue {
  config: FlintConfig;
  origins: Record<string, ConfigOrigin>;
  notice: ConfigNotice | null;
  loaded: boolean;
  setField: (path: string, value: unknown) => void;
  resetField: (path: string) => void;
  dismissNotice: () => void;
  /** Trigger a fresh full-config fetch, e.g. once a workspace becomes available. */
  refresh: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [config, setConfig] = useState<FlintConfig>(DEFAULT_CONFIG);
  const [origins, setOrigins] = useState<Record<string, ConfigOrigin>>({});
  const [notice, setNotice] = useState<ConfigNotice | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Keep the latest config in a ref so revert-on-failure can restore exactly the
  // pre-optimistic-update snapshot even across rapid consecutive setField calls.
  const configRef = useRef(config);
  configRef.current = config;
  const originsRef = useRef(origins);
  originsRef.current = origins;

  const refresh = useCallback(async () => {
    try {
      const result = await api.configGetAll();
      setConfig((result.config as FlintConfig) ?? DEFAULT_CONFIG);
      setOrigins(result.origins || {});
      setNotice(result.notice || null);
      setLoaded(true);
    } catch {
      // No workspace open yet, or the call failed — keep defaults; consumers guard on `loaded`.
      setLoaded(true);
    }
  }, []);

  const setField = useCallback((path: string, value: unknown) => {
    const previousConfig = configRef.current;
    const previousOrigins = originsRef.current;

    const nextConfig = setAtPathImmutable(previousConfig as unknown as Record<string, unknown>, path, value) as FlintConfig;
    const nextOrigins = { ...previousOrigins, [path]: 'workspace' as ConfigOrigin };
    setConfig(nextConfig);
    setOrigins(nextOrigins);

    api.configSet(path, value).catch(() => {
      setConfig(previousConfig);
      setOrigins(previousOrigins);
    });
  }, []);

  const resetField = useCallback((path: string) => {
    const previousConfig = configRef.current;
    const previousOrigins = originsRef.current;

    const defaultValue = getAtPath(DEFAULT_CONFIG, path);
    const nextConfig = (
      defaultValue === undefined
        ? deleteAtPathImmutable(previousConfig as unknown as Record<string, unknown>, path)
        : setAtPathImmutable(previousConfig as unknown as Record<string, unknown>, path, defaultValue)
    ) as FlintConfig;
    const nextOrigins = { ...previousOrigins };
    delete nextOrigins[path];
    setConfig(nextConfig);
    setOrigins(nextOrigins);

    api.configReset(path).catch(() => {
      setConfig(previousConfig);
      setOrigins(previousOrigins);
    });
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  // Fetch the full config once on mount. App.tsx additionally calls `refresh()` once the
  // workspace-open call resolves (the real signal that a workspace is available), but the
  // browser-mock/no-workspace-yet path still needs a first fetch so consumers see real
  // defaults/origins rather than only this module's hardcoded fallback.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({ config, origins, notice, loaded, setField, resetField, dismissNotice, refresh }),
    [config, origins, notice, loaded, setField, resetField, dismissNotice, refresh]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings() must be called within a <SettingsProvider>.');
  }
  return ctx;
}
