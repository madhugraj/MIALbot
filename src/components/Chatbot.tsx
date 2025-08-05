"use client";

import React, { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SendHorizonal } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { supabase } from "@/integrations/supabase/client";

interface Message {
  id: number;
  text: string;
  sender: "user" | "bot";
  isThinking?: boolean;
}

const Chatbot: React.FC = () => {
  const messageIdCounter = useRef(0);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: messageIdCounter.current++,
      text: "Hi there! Welcome to MiAL. How can I assist you today?",
      sender: "bot",
    },
  ]);
  const [input, setInput] = useState<string>("");
  const [isBotTyping, setIsBotTyping] = useState<boolean>(false);
  const [contextualSuggestions, setContextualSuggestions] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isBotTyping]);

  const sendMessage = async (text: string) => {
    if (text.trim() === "") return;

    setContextualSuggestions([]); // Clear suggestions on new message
    const newUserMessage: Message = {
      id: messageIdCounter.current++,
      text,
      sender: "user",
    };
    
    setMessages(prevMessages => [...prevMessages, newUserMessage]);
    setInput("");
    setIsBotTyping(true);

    try {
      const { data, error } = await supabase.functions.invoke('chatbot-agent', {
        body: { 
          user_query: text,
          history: messages
        },
      });

      if (error) {
        console.error("Error invoking Edge Function:", error);
        const botErrorResponse: Message = {
          id: messageIdCounter.current++,
          text: "Sorry, I couldn't process your request due to an error.",
          sender: "bot",
        };
        setMessages((prevMessages) => [...prevMessages, botErrorResponse]);
      } else {
        const botResponse: Message = {
          id: messageIdCounter.current++,
          text: data.response,
          sender: "bot",
        };
        setMessages((prevMessages) => [...prevMessages, botResponse]);

        if (data.suggestions && Array.isArray(data.suggestions)) {
          setContextualSuggestions(data.suggestions);
        }
      }
    } catch (fetchError) {
      console.error("Network or unexpected error:", fetchError);
      const botNetworkErrorResponse: Message = {
        id: messageIdCounter.current++,
        text: "It seems there's a problem connecting. Please try again later.",
        sender: "bot",
      };
      setMessages((prevMessages) => [...prevMessages, botNetworkErrorResponse]);
    } finally {
      setIsBotTyping(false);
    }
  };

  const handleSendMessage = () => {
    sendMessage(input);
  };

  const handleSuggestionClick = (query: string) => {
    setInput(query);
    inputRef.current?.focus();
  };

  const handleContextualSuggestionClick = (query: string) => {
    sendMessage(query);
  };

  const initialSuggestions = [
      { text: "Flight Arrival Time", query: "What is the arrival time for flight " },
      { text: "Check Flight Status", query: "What is the status of flight " },
      { text: "Flight Details", query: "What are the details for flight " },
      { text: "Lost & Found", query: "I have a question about lost and found." },
  ];

  return (
    <Card className="w-full max-w-lg mx-auto flex flex-col h-[700px] rounded-xl shadow-lg bg-white text-slate-800 font-sans">
      <CardHeader className="bg-slate-900 text-white p-4 rounded-t-xl flex flex-row items-center justify-between">
        <div className="flex items-center space-x-3">
          <Avatar className="w-10 h-10 border-2 border-slate-500">
            <AvatarImage src="https://github.com/shadcn.png" alt="Bot Avatar" />
            <AvatarFallback>M</AvatarFallback>
          </Avatar>
          <CardTitle className="text-lg font-semibold">Mia</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0 bg-white">
        <ScrollArea className="h-full p-6">
          <div className="flex flex-col space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex items-end gap-2 ${
                  message.sender === "user" ? "justify-end" : "justify-start"
                }`}
              >
                {message.sender === "bot" && (
                  <Avatar className="w-8 h-8">
                    <AvatarImage src="https://github.com/shadcn.png" alt="Bot Avatar" />
                    <AvatarFallback>M</AvatarFallback>
                  </Avatar>
                )}
                <div
                  className={`p-3 rounded-lg max-w-[75%] text-sm ${
                    message.sender === "user"
                      ? "bg-slate-900 text-white rounded-br-none"
                      : "bg-slate-100 text-slate-900 rounded-bl-none"
                  }`}
                >
                  {message.text}
                </div>
              </div>
            ))}
            {isBotTyping && (
              <div className="flex items-end gap-2 justify-start">
                <Avatar className="w-8 h-8">
                  <AvatarImage src="https://github.com/shadcn.png" alt="Bot Avatar" />
                  <AvatarFallback>M</AvatarFallback>
                </Avatar>
                <div className="p-3 rounded-lg bg-slate-100 text-slate-900 rounded-bl-none">
                  <div className="flex items-center justify-center space-x-1">
                    <span className="h-1.5 w-1.5 bg-slate-400 rounded-full animate-pulse [animation-delay:-0.3s]"></span>
                    <span className="h-1.5 w-1.5 bg-slate-400 rounded-full animate-pulse [animation-delay:-0.15s]"></span>
                    <span className="h-1.5 w-1.5 bg-slate-400 rounded-full animate-pulse"></span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>
      </CardContent>
      <CardFooter className="flex flex-col p-4 pt-2 border-t bg-white items-start rounded-b-xl">
        <div className="w-full mb-3">
            {contextualSuggestions.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                    {contextualSuggestions.map((suggestion, index) => (
                        <Button key={index} variant="outline" size="sm" className="rounded-full border-slate-200 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-900" onClick={() => handleContextualSuggestionClick(suggestion)}>{suggestion}</Button>
                    ))}
                </div>
            ) : (
                messages.length <= 2 && (
                    <div className="flex flex-wrap gap-2">
                        {initialSuggestions.map((suggestion, index) => (
                            <Button key={index} variant="outline" size="sm" className="rounded-full border-slate-200 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-900" onClick={() => handleSuggestionClick(suggestion.query)}>{suggestion.text}</Button>
                        ))}
                    </div>
                )
            )}
        </div>
        <div className="flex w-full items-center space-x-2">
            <Input
              ref={inputRef}
              type="text"
              placeholder="Ask Mia anything..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === "Enter") {
                  handleSendMessage();
                }
              }}
              className="flex-1 bg-slate-100 border-transparent rounded-lg focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-slate-500 h-10 px-4"
            />
            <Button onClick={handleSendMessage} className="rounded-lg w-10 h-10 p-0 flex items-center justify-center bg-slate-900 hover:bg-slate-700 transition-colors">
              <SendHorizonal className="h-5 w-5 text-white" />
            </Button>
        </div>
      </CardFooter>
    </Card>
  );
};

export default Chatbot;