import { useApp } from '../App.tsx';
import { CreateGameForm } from '../components/CreateGameForm.tsx';

export function NewGamePage() {
  const { isAdmin, navigate } = useApp();
  if (!isAdmin) return <div className="card">Game master only. Unlock with the admin token on the home page.</div>;
  return (
    <section className="card new-game">
      <h2>New game</h2>
      <CreateGameForm onCreated={(id) => navigate(`/game/${id}`)} />
    </section>
  );
}
