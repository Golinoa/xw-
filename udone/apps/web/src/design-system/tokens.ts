import type { ConfigProviderProps } from 'ant-design-vue';

export const designTokens = {
  colors: {
    brandBlue: '#0093FF',
    brandCyan: '#00D1C3',
    primary: '#0077D6',
    primaryHover: '#005EAA',
    primaryActive: '#00477F',
    info: '#0093FF',
    success: '#16A34A',
    successText: '#166534',
    warning: '#F08A00',
    warningText: '#9A4D00',
    error: '#EF4444',
    errorText: '#B42318',
    canvas: '#F0F8FD',
    surface: '#FFFFFF',
    surfaceMuted: '#F5F9FC',
    text: '#34424D',
    heading: '#101820',
    secondaryText: '#4B5B68',
    mutedText: '#536370',
    placeholder: '#91A0AD',
    border: '#D7E0E8',
    borderSubtle: '#E3EDF4',
    disabledBackground: '#EAF0F5',
  },
  spacing: [2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 80, 96, 102, 128],
  typography: {
    fontFamily:
      '"PingFang SC", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif',
    sizes: {
      xs: { fontSize: 12, lineHeight: 20 },
      sm: { fontSize: 14, lineHeight: 22 },
      md: { fontSize: 16, lineHeight: 24 },
      lg: { fontSize: 18, lineHeight: 28 },
      xl: { fontSize: 20, lineHeight: 28 },
      '2xl': { fontSize: 22, lineHeight: 32 },
      '3xl': { fontSize: 24, lineHeight: 32 },
    },
    weights: { regular: 400, medium: 500, semibold: 600 },
  },
  radius: 4,
} as const;

export const antDesignTheme = {
  token: {
    colorPrimary: designTokens.colors.primary,
    colorInfo: designTokens.colors.info,
    colorSuccess: designTokens.colors.success,
    colorWarning: designTokens.colors.warning,
    colorError: designTokens.colors.error,
    colorTextBase: designTokens.colors.text,
    colorBgBase: designTokens.colors.canvas,
    colorBgLayout: designTokens.colors.canvas,
    colorBgContainer: designTokens.colors.surface,
    colorText: designTokens.colors.text,
    colorTextHeading: designTokens.colors.heading,
    colorTextSecondary: designTokens.colors.secondaryText,
    colorTextTertiary: designTokens.colors.mutedText,
    colorTextPlaceholder: designTokens.colors.placeholder,
    colorBorder: designTokens.colors.border,
    colorBorderSecondary: designTokens.colors.borderSubtle,
    colorLink: designTokens.colors.primaryHover,
    colorLinkHover: designTokens.colors.primary,
    colorLinkActive: designTokens.colors.primaryActive,
    colorPrimaryHover: designTokens.colors.primaryHover,
    colorPrimaryActive: designTokens.colors.primaryActive,
    fontFamily: designTokens.typography.fontFamily,
    fontSize: designTokens.typography.sizes.sm.fontSize,
    lineHeight: 22 / 14,
    fontWeightStrong: designTokens.typography.weights.semibold,
    fontSizeHeading1: 24,
    fontSizeHeading2: 22,
    fontSizeHeading3: 20,
    fontSizeHeading4: 18,
    fontSizeHeading5: 16,
    lineHeightHeading1: 32 / 24,
    lineHeightHeading2: 32 / 22,
    lineHeightHeading3: 28 / 20,
    lineHeightHeading4: 28 / 18,
    lineHeightHeading5: 24 / 16,
    borderRadius: designTokens.radius,
    borderRadiusXS: designTokens.radius,
    borderRadiusSM: designTokens.radius,
    borderRadiusLG: designTokens.radius,
    paddingXXS: 2,
    paddingXS: 4,
    paddingSM: 8,
    padding: 12,
    paddingMD: 16,
    paddingLG: 24,
    paddingXL: 32,
    marginXXS: 2,
    marginXS: 4,
    marginSM: 8,
    margin: 12,
    marginMD: 16,
    marginLG: 24,
    marginXL: 32,
    marginXXL: 40,
  },
} satisfies NonNullable<ConfigProviderProps['theme']>;

export function applyCssTokens() {
  const root = document.documentElement;

  Object.entries(designTokens.colors).forEach(([name, value]) => {
    root.style.setProperty(
      `--color-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      value,
    );
  });

  designTokens.spacing.forEach((value) => root.style.setProperty(`--space-${value}`, `${value}px`));
  Object.entries(designTokens.typography.sizes).forEach(([name, value]) => {
    root.style.setProperty(`--font-size-${name}`, `${value.fontSize}px`);
    root.style.setProperty(`--line-height-${name}`, `${value.lineHeight}px`);
  });
  root.style.setProperty('--font-family-ui', designTokens.typography.fontFamily);
  root.style.setProperty('--radius-default', `${designTokens.radius}px`);
}
