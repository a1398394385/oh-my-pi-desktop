import { useAppStore } from "../../store";
import { toggleSidebar, toggleRightPanel } from "../../shell";
import MainHeader from "./MainHeader";
import Welcome from "./WelcomePage";
import MessagePage from "./chat/MessagePage";
import AgentHub from "./AgentHubPage";
import MainSessionTree from "./tree/MainSessionTree";
import Composer from "../Composer";
import ApprovalCard from "../chat/ApprovalCard";
import SessionStatsBar from "./SessionStatsBar";
import QueueCard from "../composer/QueueCard";
import GoalCard from "../composer/GoalCard";
import ConnBanner from "./ConnBanner";

export default function MainColumn() {
  const isCreatingNew = useAppStore((s) => s.isCreatingNew);
  const hubOpen = useAppStore((s) => s.hubOpen);
  const mainViewMode = useAppStore((s) => s.mainViewMode);
  const activePath = useAppStore((s) => s.activePath);
  const session = useAppStore((s) => s.activePath ? s.openSessions.get(s.activePath) : undefined);
  const pendingApproval = session?.pendingApprovals?.[0] ?? null;
  return (
      <main id="main">
        <MainHeader onToggleSidebar={toggleSidebar} onToggleRight={toggleRightPanel} />
        <ConnBanner />
        {isCreatingNew ? <Welcome /> : hubOpen ? <AgentHub /> : session && mainViewMode === "tree" ? <MainSessionTree /> : <MessagePage />}
        {!isCreatingNew && !hubOpen && (
          <>
            {/* Goal bar -> queue card -> input dock: three stacked cards from
                top down (the goal bar shifts up as the queue grows). Each card
                pulls up with -mb-28px and the next card presses on its bottom
                edge with z, exposing the upper half as a second-level stack */}
            <GoalCard />
            <QueueCard />
            <div className={pendingApproval ? "dock approval-active" : "dock"}>
              {pendingApproval ? <ApprovalCard key={pendingApproval.requestId} item={pendingApproval} /> : null}
              <Composer key={activePath || "composer"} inWelcome={false} blocking={Boolean(pendingApproval)} />
            </div>
            {/* Session stats row: outside the dock, on its own row below the
                composer card (not inside the composer) */}
            <SessionStatsBar />
          </>
        )}
      </main>
  );
}
