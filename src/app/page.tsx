
import { AppHeader } from '@/components/layout/header';
import { ChatInterface } from '@/components/chat/chat-interface';

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen bg-background">
      <AppHeader />
      <main className="flex-grow container mx-auto px-4 py-8 flex flex-col items-center">
        <ChatInterface />
      </main>
      <footer className="py-4 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} MediMate AI. All rights reserved.</p>
      </footer>
    </div>
  );
}
