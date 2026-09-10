import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  loadSettings,
  saveSettings,
  translate,
  type MessageKey,
  type MessageParams,
  type UiSettings,
} from "./settings";

/**
 * settings.ts (pure module) の React バインディング。
 * UiSettingsProvider が localStorage と React state を繋ぎ、
 * ページ側は useT / useUiSettings の薄い消費者として触るだけにする。
 */

type UiSettingsValue = {
  settings: UiSettings;
  update: (patch: Partial<UiSettings>) => void;
};

const UiSettingsContext = createContext<UiSettingsValue | null>(null);

export function UiSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UiSettings>(() =>
    loadSettings(localStorage)
  );

  // html[lang] をアクティブ locale に追従させる
  useEffect(() => {
    document.documentElement.lang = settings.locale;
  }, [settings.locale]);

  const update = useCallback((patch: Partial<UiSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(localStorage, next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return (
    <UiSettingsContext.Provider value={value}>
      {children}
    </UiSettingsContext.Provider>
  );
}

export function useUiSettings(): UiSettingsValue {
  const ctx = useContext(UiSettingsContext);
  if (!ctx) throw new Error("useUiSettings outside UiSettingsProvider");
  return ctx;
}

/** アクティブ locale にバインドした翻訳関数を返す (EN フォールバック付き) */
export function useT() {
  const { settings } = useUiSettings();
  const locale = settings.locale;
  return useCallback(
    (key: MessageKey, params?: MessageParams) => translate(locale, key, params),
    [locale]
  );
}
