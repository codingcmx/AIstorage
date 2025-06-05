import { kv } from './kv';
import type { ConversationState, Message } from '@/types/conversation';
import { format, subDays } from 'date-fns';

const CONVERSATION_EXPIRY_DAYS = 10;

// Helper to generate the KV key for a user's conversation state
function getConversationKey(userId: string): string {
  return `conversation:${userId}`;
}

// Load the conversation state for a user
export async function loadConversationState(userId: string): Promise<ConversationState | null> {
  try {
    const state = await kv.get<ConversationState>(getConversationKey(userId));
    return state;
  } catch (error) {
    console.error(`[Conversation State] Error loading state for user ${userId}:`, error);
    return null;
  }
}

// Save the conversation state for a user
export async function saveConversationState(userId: string, state: ConversationState): Promise<boolean> {
  try {
    await kv.set(getConversationKey(userId), state);
    return true;
  } catch (error) {
    console.error(`[Conversation State] Error saving state for user ${userId}:`, error);
    return false;
  }
}

// Add a message to the conversation history
export async function addMessageToHistory(
  userId: string,
  message: Omit<Message, 'timestamp'>,
  updateBookingDetails?: Partial<ConversationState['bookingDetails']>
): Promise<boolean> {
  try {
    const state = await loadConversationState(userId) || {
      history: [],
      lastActive: new Date().toISOString(),
    };

    // Add the new message
    state.history.push({
      ...message,
      timestamp: new Date().toISOString(),
    });

    // Update booking details if provided
    if (updateBookingDetails) {
      state.bookingDetails = {
        ...state.bookingDetails,
        ...updateBookingDetails,
      };
    }

    // Update last active timestamp
    state.lastActive = new Date().toISOString();

    // Prune old messages
    const cutoffDate = subDays(new Date(), CONVERSATION_EXPIRY_DAYS);
    state.history = state.history.filter(msg => 
      new Date(msg.timestamp) > cutoffDate
    );

    return await saveConversationState(userId, state);
  } catch (error) {
    console.error(`[Conversation State] Error adding message for user ${userId}:`, error);
    return false;
  }
}

// Update the current flow state
export async function updateFlowState(
  userId: string,
  flow: ConversationState['currentFlow'],
  bookingDetails?: Partial<ConversationState['bookingDetails']>
): Promise<boolean> {
  try {
    const state = await loadConversationState(userId) || {
      history: [],
      lastActive: new Date().toISOString(),
    };

    state.currentFlow = flow;
    if (bookingDetails) {
      state.bookingDetails = {
        ...state.bookingDetails,
        ...bookingDetails,
      };
    }

    state.lastActive = new Date().toISOString();
    return await saveConversationState(userId, state);
  } catch (error) {
    console.error(`[Conversation State] Error updating flow state for user ${userId}:`, error);
    return false;
  }
}

// Clear the conversation state (useful after completing a booking or cancellation)
export async function clearConversationState(userId: string): Promise<boolean> {
  try {
    await kv.del(getConversationKey(userId));
    return true;
  } catch (error) {
    console.error(`[Conversation State] Error clearing state for user ${userId}:`, error);
    return false;
  }
} 