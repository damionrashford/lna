import { useStore } from "./store";
import Header from "./components/Header";
import ConnectGate from "./components/ConnectGate";
import Thread from "./components/Thread";
import Composer from "./components/Composer";
import Settings from "./components/Settings";

export default function App() {
  const { connected } = useStore();
  return (
    <>
      <Header />
      <main>{connected ? <Thread /> : <ConnectGate />}</main>
      {connected && <Composer />}
      <Settings />
    </>
  );
}
