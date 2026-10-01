import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** `acevra.account.*` strings with an English fallback (same pattern as first-run setup). */
export function useAccountText() {
  const { intl } = useZCodeIntl();
  return (id: string, fallback: string) => {
    const key = `acevra.account.${id}`;
    const message = intl.formatMessage({ id: key });
    return message === key ? fallback : message;
  };
}
