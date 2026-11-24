export type ThemePreference = "auto" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export interface ThemeControllerOptions {
  readonly storageKey: string;
  readonly getDevToolsTheme?: (() => ResolvedTheme | null) | undefined;
  readonly onChange?:
    | ((preference: ThemePreference, resolved: ResolvedTheme) => void)
    | undefined;
}

export interface ThemeController {
  getPreference(): ThemePreference;
  getResolvedTheme(): ResolvedTheme;
  setPreference(preference: ThemePreference): void;
  cycle(): ThemePreference;
  apply(): void;
  dispose(): void;
}

function readStoredTheme(storageKey: string): ThemePreference {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === "dark" || raw === "light" || raw === "auto") {
      return raw;
    }
  } catch {
    // Storage may be unavailable in restricted contexts
  }
  return "auto";
}

function writeStoredTheme(storageKey: string, pref: ThemePreference): void {
  try {
    window.localStorage.setItem(storageKey, pref);
  } catch {
    // Ignore storage write errors
  }
}

export function createThemeController(
  options: ThemeControllerOptions,
): ThemeController {
  let preference: ThemePreference = readStoredTheme(options.storageKey);
  const colorSchemeMedia =
    typeof window !== "undefined"
      ? window.matchMedia?.("(prefers-color-scheme: dark)")
      : undefined;

  const resolveEffectiveTheme = (): ResolvedTheme => {
    if (preference === "dark" || preference === "light") {
      return preference;
    }
    const devtoolsTheme = options.getDevToolsTheme?.() ?? null;
    if (devtoolsTheme) {
      return devtoolsTheme;
    }
    return colorSchemeMedia?.matches ? "dark" : "light";
  };

  const apply = (): void => {
    if (typeof document !== "undefined") {
      if (preference === "auto") {
        const devtoolsTheme = options.getDevToolsTheme?.() ?? null;
        if (devtoolsTheme) {
          document.documentElement.dataset.theme = devtoolsTheme;
        } else {
          delete document.documentElement.dataset.theme;
        }
      } else {
        document.documentElement.dataset.theme = preference;
      }
    }
    options.onChange?.(preference, resolveEffectiveTheme());
  };

  const onColorSchemeChange = (): void => {
    if (preference === "auto") {
      apply();
    }
  };

  colorSchemeMedia?.addEventListener?.("change", onColorSchemeChange);
  apply();

  return {
    getPreference() {
      return preference;
    },
    getResolvedTheme() {
      return resolveEffectiveTheme();
    },
    setPreference(next) {
      preference = next;
      writeStoredTheme(options.storageKey, preference);
      apply();
    },
    cycle() {
      const next: ThemePreference =
        preference === "auto"
          ? "dark"
          : preference === "dark"
            ? "light"
            : "auto";
      preference = next;
      writeStoredTheme(options.storageKey, preference);
      apply();
      return preference;
    },
    apply,
    dispose() {
      colorSchemeMedia?.removeEventListener?.("change", onColorSchemeChange);
    },
  };
}
