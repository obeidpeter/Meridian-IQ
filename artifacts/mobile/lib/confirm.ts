import { Alert, Platform } from "react-native";

/**
 * Platform-aware confirm, shared by the automation, bills and invoices
 * screens (previously three inline copies): Alert.alert is a no-op on
 * react-native-web, so fall back to the browser's native confirm there.
 */
export function confirmThen(
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void,
  destructive = false,
) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    {
      text: confirmLabel,
      style: destructive ? "destructive" : "default",
      onPress: onConfirm,
    },
  ]);
}
