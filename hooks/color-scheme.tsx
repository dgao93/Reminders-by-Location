import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme as useRNColorScheme, type ColorSchemeName } from 'react-native';

const STORAGE_KEY = 'settings.colorScheme';

type AppColorScheme = 'light' | 'dark';

type ColorSchemeContextValue = {
  colorScheme: AppColorScheme;
  isDarkMode: boolean;
  setDarkMode: (enabled: boolean) => void;
};

const ColorSchemeContext = createContext<ColorSchemeContextValue | null>(null);

const normalizeColorScheme = (scheme: ColorSchemeName): AppColorScheme =>
  scheme === 'dark' ? 'dark' : 'light';

export function ColorSchemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useRNColorScheme();
  const hasUserPreferenceRef = useRef(false);
  const [hasUserPreference, setHasUserPreference] = useState(false);
  const [colorScheme, setColorScheme] = useState<AppColorScheme>(
    normalizeColorScheme(systemScheme)
  );

  useEffect(() => {
    let isMounted = true;

    AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (!isMounted) {
          return;
        }
        if (hasUserPreferenceRef.current) {
          return;
        }

        if (value === 'light' || value === 'dark') {
          setColorScheme(value);
          setHasUserPreference(true);
          hasUserPreferenceRef.current = true;
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!hasUserPreference) {
      setColorScheme(normalizeColorScheme(systemScheme));
    }
  }, [systemScheme, hasUserPreference]);

  const setDarkMode = useCallback((enabled: boolean) => {
    const nextScheme: AppColorScheme = enabled ? 'dark' : 'light';
    setColorScheme(nextScheme);
    setHasUserPreference(true);
    hasUserPreferenceRef.current = true;
    AsyncStorage.setItem(STORAGE_KEY, nextScheme).catch(() => {});
  }, []);

  const value = useMemo(
    () => ({
      colorScheme,
      isDarkMode: colorScheme === 'dark',
      setDarkMode,
    }),
    [colorScheme, setDarkMode]
  );

  return <ColorSchemeContext.Provider value={value}>{children}</ColorSchemeContext.Provider>;
}

export function useAppColorScheme() {
  const systemScheme = useRNColorScheme();
  const context = useContext(ColorSchemeContext);

  return context?.colorScheme ?? normalizeColorScheme(systemScheme);
}

export function useDarkModeToggle() {
  const systemScheme = useRNColorScheme();
  const context = useContext(ColorSchemeContext);

  if (context) {
    return { isDarkMode: context.isDarkMode, setDarkMode: context.setDarkMode };
  }

  return { isDarkMode: normalizeColorScheme(systemScheme) === 'dark', setDarkMode: () => {} };
}
