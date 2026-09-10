import { StyleSheet } from "react-native";

// Shared by the status-light, transmission-failed and history cards.
export const styles = StyleSheet.create({
  bannerRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  lightDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  attemptRow: {
    flexDirection: "row",
    gap: 12,
    padding: 14,
    alignItems: "flex-start",
  },
});
