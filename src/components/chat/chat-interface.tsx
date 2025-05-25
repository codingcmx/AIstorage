
"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { Message, SenderType } from '@/types/chat';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { SendHorizontal, Loader2, Newspaper } from 'lucide-react';
import { MessageBubble } from './message-bubble';
import { SenderToggle } from './sender-toggle';
import { handleUserMessage, getDailySummaryAction } from '@/lib/actions';
import { useToast } from "@/hooks/use-toast";

// Helper function to generate a unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentSenderType, setCurrentSenderType] = useState<SenderType>('patient');
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const addMessage = useCallback((message: Omit<Message, 'id' | 'timestamp'>) => {
    setMessages((prevMessages) => [
      ...prevMessages,
      { ...message, id: generateId(), timestamp: new Date() },
    ]);
  }, []);

  useEffect(() => {
    addMessage({
      sender: 'ai',
      content: "Hello! I'm MediMate AI, your virtual assistant for appointment scheduling. How can I help you today?",
    });
    inputRef.current?.focus();
  }, [addMessage]);
  
  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTo({ top: scrollAreaRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  const handleSendMessage = async (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    const text = inputValue.trim();
    if (!text) return;

    addMessage({ sender: 'user', content: text });
    setInputValue('');
    setIsLoading(true);
    
    const aiLoadingMessageId = generateId();
    setMessages((prevMessages) => [
      ...prevMessages,
      { id: aiLoadingMessageId, sender: 'ai', content: '', timestamp: new Date(), isLoading: true },
    ]);

    try {
      const result = await handleUserMessage(text, currentSenderType);
      setMessages((prevMessages) => 
        prevMessages.map(msg => 
          msg.id === aiLoadingMessageId 
          ? { ...msg, content: result.responseText, intent: result.intent, entities: result.entities, isLoading: false }
          : msg
        )
      );
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages((prevMessages) => 
        prevMessages.map(msg => 
          msg.id === aiLoadingMessageId 
          ? { ...msg, content: "Sorry, something went wrong. Please try again.", isLoading: false }
          : msg
        )
      );
      toast({
        title: "Error",
        description: "Could not process your message. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleViewSummary = async () => {
    setIsLoading(true);
    const summaryLoadingMessageId = generateId();
     setMessages((prevMessages) => [
      ...prevMessages,
      { id: summaryLoadingMessageId, sender: 'system', content: '', timestamp: new Date(), isLoading: true },
    ]);

    try {
      const summary = await getDailySummaryAction();
       setMessages((prevMessages) => 
        prevMessages.map(msg => 
          msg.id === summaryLoadingMessageId 
          ? { ...msg, content: `Today's Summary:\n${summary}`, isLoading: false }
          : msg
        )
      );
    } catch (error) {
      console.error('Error fetching summary:', error);
      setMessages((prevMessages) => 
        prevMessages.map(msg => 
          msg.id === summaryLoadingMessageId 
          ? { ...msg, content: "Sorry, couldn't fetch the summary.", isLoading: false }
          : msg
        )
      );
      toast({
        title: "Error",
        description: "Could not fetch daily summary.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };


  return (
    <Card className="w-full max-w-2xl mx-auto flex flex-col shadow-xl rounded-lg">
      <CardHeader className="p-4 border-b">
        <SenderToggle currentSender={currentSenderType} onSenderChange={setCurrentSenderType} />
      </CardHeader>
      <CardContent className="p-0 flex-grow">
        <ScrollArea className="h-[500px] p-4" ref={scrollAreaRef}>
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
        </ScrollArea>
      </CardContent>
      <CardFooter className="p-4 border-t">
        <form onSubmit={handleSendMessage} className="flex w-full items-center gap-2">
          <Input
            ref={inputRef}
            type="text"
            placeholder="Type your message..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="flex-grow text-base"
            disabled={isLoading}
            aria-label="Chat input"
          />
          <Button type="submit" size="icon" disabled={isLoading || !inputValue.trim()} aria-label="Send message">
            {isLoading && messages[messages.length -1]?.sender === 'user' ? <Loader2 className="h-5 w-5 animate-spin" /> : <SendHorizontal className="h-5 w-5" />}
          </Button>
          <Button type="button" variant="outline" onClick={handleViewSummary} disabled={isLoading} aria-label="View today's summary">
            <Newspaper className="h-5 w-5 mr-2" />
            Summary
          </Button>
        </form>
      </CardFooter>
    </Card>
  );
}
