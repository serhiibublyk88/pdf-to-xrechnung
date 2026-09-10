import { themeInitScript } from './theme-script';

export function ThemeInitScript({ nonce }: { nonce?: string }) {
  return (
    <script
      type="text/javascript"
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: themeInitScript }}
    />
  );
}
