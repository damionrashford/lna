import { useStore } from "./store";
import { ChatProvider } from "./chat";
import Header from "./components/Header";
import ConnectGate from "./components/ConnectGate";
import Thread from "./components/Thread";
import Composer from "./components/Composer";
import Settings from "./components/Settings";
import DebugPanel from "./components/DebugPanel";
import Onboarding from "./components/Onboarding";

export default function App() {
  const { connected } = useStore();
  return (
    <ChatProvider>
      <Header />
      <main>{connected ? <Thread /> : <ConnectGate />}</main>
      {connected && <Composer />}
      <Settings />
      <DebugPanel />
      <Onboarding />
    </ChatProvider>
  );
}
