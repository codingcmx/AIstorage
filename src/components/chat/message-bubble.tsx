
"use client";

import type { Message } from '@/types/chat';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Bot, User, Info } from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter } from '@/components/ui/card';

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.sender === 'user';
  const isSystem = message.sender === 'system';

  const avatarIcon = isUser ? <User className="h-5 w-5" /> : isSystem ? <Info className="h-5 w-5" /> : <Bot className="h-5 w-5" />;
  const avatarFallback = isUser ? 'U' : isSystem ? 'S' : 'AI';

  return (
    <div
      className={cn(
        'flex items-end gap-2 mb-4 animate-in fade-in duration-300',
        isUser ? 'justify-end' : 'justify-start'
      )}
    >
      {!isUser && (
        <Avatar className="h-8 w-8">
          {/* Placeholder for actual avatar image if available */}
          {/* <AvatarImage src="https://placehold.co/40x40.png" alt={avatarFallback} /> */}
          <AvatarFallback className={cn(
            isSystem ? "bg-accent text-accent-foreground" : "bg-primary text-primary-foreground"
            )}>
            {avatarIcon}
          </AvatarFallback>
        </Avatar>
      )}
      <Card
        className={cn(
          'max-w-[75%] p-0 shadow-md',
          isUser ? 'bg-primary text-primary-foreground rounded-br-none' : 
          isSystem ? 'bg-secondary text-secondary-foreground rounded-bl-none' : 'bg-card text-card-foreground rounded-bl-none'
        )}
      >
        <CardContent className="p-3">
          {message.isLoading ? (
            <div className="flex items-center space-x-1">
              <span className="h-2 w-2 animate-pulse rounded-full bg-current opacity-60 [animation-delay:-0.3s]" />
              <span className="h-2 w-2 animate-pulse rounded-full bg-current opacity-60 [animation-delay:-0.15s]" />
              <span className="h-2 w-2 animate-pulse rounded-full bg-current opacity-60" />
            </div>
          ) : (
             <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          )}
        </CardContent>
        {!message.isLoading && (
          <CardFooter className="px-3 py-1 text-xs opacity-70 flex justify-between items-center">
            <span>
              {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
             {message.sender === 'ai' && (message.intent || message.entities) && (
              <span className="text-right">
                {message.intent && `Intent: ${message.intent}`}
              </span>
            )}
          </CardFooter>
        )}
         {message.sender === 'ai' && message.entities && Object.keys(message.entities).length > 0 && (
            <CardDescription className="px-3 pb-2 pt-0 text-xs opacity-60">
              Entities: {JSON.stringify(message.entities)}
            </CardDescription>
          )}
      </Card>
      {isUser && (
        <Avatar className="h-8 w-8">
          {/* <AvatarImage src="https://placehold.co/40x40.png" alt="User" /> */}
          <AvatarFallback className="bg-accent text-accent-foreground">
            {avatarIcon}
          </AvatarFallback>
        </Avatar>
      )}
    </div>
  );
}
