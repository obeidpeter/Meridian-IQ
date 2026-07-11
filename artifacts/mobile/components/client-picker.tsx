import { Feather } from "@expo/vector-icons";
import { PartyType, useListParties } from "@workspace/api-client-react";
import type { Party } from "@workspace/api-client-react";
import React, { useEffect, useMemo } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  AppButton,
  AppText,
  Card,
  CardSkeleton,
  Divider,
  EmptyState,
  ErrorState,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useSession } from "@/lib/session";

/**
 * Shown when the signed-in principal has no bound client party. The user
 * chooses which client business the app should operate on; the choice is
 * persisted so it isn't asked again.
 */
export function ClientPicker() {
  const colors = useColors();
  const { selectClient, signOut } = useSession();
  const parties = useListParties();

  // Memoized so the auto-select effect below has a stable dependency (a fresh
  // filter() each render would otherwise re-run the effect every render).
  const clients = useMemo<Party[]>(
    () =>
      (parties.data ?? []).filter(
        (p) => p.type === PartyType.client_business,
      ),
    [parties.data],
  );

  // Auto-select when there is exactly one client business.
  useEffect(() => {
    if (parties.isSuccess && clients.length === 1) {
      void selectClient(clients[0].id);
    }
  }, [parties.isSuccess, clients, selectClient]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={styles.container}>
        <AppText variant="title">Choose a client</AppText>
        <AppText
          variant="body"
          color={colors.mutedForeground}
          style={{ marginTop: 6 }}
        >
          Select the business you want to manage compliance for.
        </AppText>

        <View style={{ flex: 1, marginTop: 20 }}>
          {parties.isLoading ? (
            <View style={{ gap: 12 }}>
              <CardSkeleton lines={1} />
              <CardSkeleton lines={1} />
            </View>
          ) : parties.isError ? (
            <ErrorState
              message="We couldn't load your clients."
              onRetry={() => parties.refetch()}
            />
          ) : clients.length === 0 ? (
            <EmptyState
              icon="briefcase"
              title="No client businesses"
              message="Ask your firm administrator to link a client business to your account."
            />
          ) : (
            <ScrollView showsVerticalScrollIndicator={false}>
              <Card padded={false}>
                {clients.map((client, index) => (
                  <View key={client.id}>
                    {index > 0 ? <Divider /> : null}
                    <Pressable
                      onPress={() => selectClient(client.id)}
                      accessibilityRole="button"
                      accessibilityLabel={
                        client.tin
                          ? `${client.legalName}, TIN ${client.tin}`
                          : client.legalName
                      }
                      style={({ pressed }) => [
                        styles.row,
                        { opacity: pressed ? 0.6 : 1 },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <AppText variant="heading">{client.legalName}</AppText>
                        {client.tin ? (
                          <AppText
                            variant="caption"
                            color={colors.mutedForeground}
                            style={{ marginTop: 2 }}
                          >
                            TIN {client.tin}
                          </AppText>
                        ) : null}
                      </View>
                      <Feather
                        name="chevron-right"
                        size={20}
                        color={colors.mutedForeground}
                      />
                    </Pressable>
                  </View>
                ))}
              </Card>
            </ScrollView>
          )}
        </View>

        <View style={{ marginTop: 16 }}>
          <AppButton
            label="Sign out"
            variant="ghost"
            icon="log-out"
            onPress={() => signOut()}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 12,
    ...(Platform.OS === "web"
      ? { maxWidth: 560, alignSelf: "center", width: "100%" }
      : {}),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
  },
});
