import OperatorPage from "./Operator";
import { coverage, listEpisodes } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <OperatorPage firstTask={coverage(await listEpisodes()).next} />;
}
