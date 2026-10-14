import { useQuery } from "@tanstack/react-query";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";

/** Local implicit boards and instance admins manage instance-wide settings. */
export function isInstanceAdminAccess(boardAccess: Pick<CurrentBoardAccess, "isInstanceAdmin" | "source"> | null | undefined): boolean {
  return Boolean(boardAccess && (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin));
}

/**
 * Whether the signed-in board is an instance admin, from the current board
 * access snapshot. False while unknown. Only decides what to offer; the server
 * stays authoritative.
 */
export function useIsInstanceAdmin(): boolean {
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
    staleTime: 30_000,
  });
  return isInstanceAdminAccess(boardAccess.data);
}
