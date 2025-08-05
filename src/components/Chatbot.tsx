"use client";

import React, { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SendHorizonal, Plus, Mic, Edit, X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { supabase } from "@/integrations/supabase/client";

interface Message {
  id: number;
  text: string;
  sender: "user" | "bot";
  isThinking?: boolean;
}

const Chatbot: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
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
      id: Date.now(),
      text,
      sender: "user",
    };
    
    const updatedMessages = [...messages, newUserMessage];
    setMessages(updatedMessages);
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
          id: Date.now() + 1,
          text: "Sorry, I couldn't process your request due to an error.",
          sender: "bot",
        };
        setMessages((prevMessages) => [...prevMessages, botErrorResponse]);
      } else {
        const botResponse: Message = {
          id: Date.now() + 1,
          text: data.response,
          sender: "bot",
        };
        setMessages((prevMessages) => [...prevMessages, botResponse]);

        // After a successful response, check if we should show contextual suggestions
        const userQuery = text.toLowerCase();
        if (userQuery.includes('flight') || userQuery.includes('airline')) {
            setContextualSuggestions([
                "What is its arrival time?",
                "What is its departure time?",
                "Which gate is it at?",
                "What is the flight status?",
            ]);
        }
      }
    } catch (fetchError) {
      console.error("Network or unexpected error:", fetchError);
      const botNetworkErrorResponse: Message = {
        id: Date.now() + 1,
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
    <Card className="w-full max-w-md mx-auto flex flex-col h-[700px] rounded-2xl shadow-xl bg-white text-card-foreground">
      <CardHeader className="bg-[#6A0DAD] text-white p-4 rounded-t-2xl flex flex-row items-center justify-between">
        <div className="flex items-center space-x-3">
          <Avatar className="w-9 h-9">
            <AvatarImage src="https://github.com/shadcn.png" alt="Bot Avatar" />
            <AvatarFallback>M</AvatarFallback>
          </Avatar>
          <CardTitle className="text-lg font-semibold">Talk to Mia</CardTitle>
        </div>
        <div className="flex space-x-2">
          <Button variant="ghost" size="icon" className="text-white hover:bg-white/20">
            <Edit className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" className="text-white hover:bg-white/20">
            <X className="h-5 w-5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0 bg-gray-50">
        <ScrollArea className="h-full p-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`mb-3 flex ${
                message.sender === "user" ? "justify-end" : "justify-start"
              }`}
            >
              {message.sender === "bot" && (
                <Avatar className="w-8 h-8 mr-2 mt-auto">
                  <AvatarImage src="https://github.com/shadcn.png" alt="Bot Avatar" />
                  <AvatarFallback>M</AvatarFallback>
                </Avatar>
              )}
              <div
                className={`p-3 rounded-xl max-w-[75%] ${
                  message.sender === "user"
                    ? "bg-[#6A0DAD] text-white rounded-br-sm rounded-tl-xl rounded-tr-xl rounded-bl-xl"
                    : "bg-gray-100 text-gray-800 rounded-bl-sm rounded-tl-xl rounded-tr-xl rounded-br-xl"
                }`}
              >
                {message.text}
              </div>
            </div>
          ))}
          {isBotTyping && (
            <div className="mb-3 flex justify-start">
              <Avatar className="w-8 h-8 mr-2 mt-auto">
                <AvatarImage src="https://github.com/shadcn.png" alt="Bot Avatar" />
                <AvatarFallback>M</AvatarFallback>
              </Avatar>
              <div className="p-3 rounded-xl bg-gray-100 text-gray-800 rounded-bl-sm rounded-tl-xl rounded-tr-xl rounded-br-xl">
                <span className="animate-pulse">...</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </ScrollArea>
      </CardContent>
      <CardFooter className="flex flex-col p-4 border-t bg-white items-start">
        <div className="w-full mb-4">
            {contextualSuggestions.length > 0 ? (
                <>
                    <p className="text-xs text-gray-500 mb-2 font-medium">You could also ask...</p>
                    <div className="flex flex-wrap gap-2">
                        {contextualSuggestions.map((suggestion, index) => (
                            <Button key={index} variant="outline" size="sm" className="rounded-full" onClick={() => handleContextualSuggestionClick(suggestion)}>{suggestion}</Button>
                        ))}
                    </div>
                </>
            ) : (
                <>
                    <p className="text-xs text-gray-500 mb-2 font-medium">Or try one of these</p>
                    <div className="flex flex-wrap gap-2">
                        {initialSuggestions.map((suggestion, index) => (
                            <Button key={index} variant="outline" size="sm" className="rounded-full" onClick={() => handleSuggestionClick(suggestion.query)}>{suggestion.text}</Button>
                        ))}
                    </div>
                </>
            )}
        </div>
        <div className="flex w-full items-center">
            <Button variant="ghost" size="icon" className="text-gray-500 hover:bg-gray-100 rounded-full mr-1">
              <Plus className="h-5 w-5" />
            </Button>
            <Input
              ref={inputRef}
              type="text"
              placeholder="Ask me anything..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === "Enter") {
                  handleSendMessage();
                }
              }}
              className="flex-1 mx-2 rounded-full bg-gray-100 border-none focus-visible:ring-0 focus-visible:ring-offset-0 h-10 px-4"
            />
            <Button variant="ghost" size="icon" className="text-gray-500 hover:bg-gray-100 rounded-full mr-1">
              <Mic className="h-5 w-5" />
            </Button>
            <Button onClick={handleSendMessage} className="rounded-full w-10 h-10 p-0 flex items-center justify-center bg-[#6A0DAD] hover:bg-[#5A0CA0]">
              <SendHorizonal className="h-5 w-5 text-white" />
            </Button>
        </div>
      </CardFooter>
    </Card>
  );
};

export default Chatbot;