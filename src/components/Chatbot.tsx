"use client";

import React, { useState, useRef, useEffect } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SendHorizonal, MessageSquarePlus, X, Plus, Mic, Database } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { supabase } from "@/integrations/supabase/client";

interface Message {
  id: number;
  text: string;
  sender: "user" | "bot";
  generatedSql?: string | null;
}

const PRE_POPULATED_QUESTIONS = [
  "What's the status of flight BA209 to London?",
  "Which gate does flight QF16 depart from?",
  "Has flight LH463 from Frankfurt arrived?",
  "Are there any delayed flights to New York?",
];

const Chatbot: React.FC = () => {
  const messageIdCounter = useRef(0);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: messageIdCounter.current++,
      text: "Hello! How can I assist you today?",
      sender: "bot",
    },
  ]);
  const [input, setInput] = useState<string>("");
  const [isBotTyping, setIsBotTyping] = useState<boolean>(false);
  const [suggestions, setSuggestions] = useState<string[]>(PRE_POPULATED_QUESTIONS);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isBotTyping]);

  const sendMessage = async (text: string) => {
    if (text.trim() === "") return;

    setSuggestions([]);
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
          history: messages.map(m => ({ text: m.text, sender: m.sender }))
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
          generatedSql: data.generatedSql,
        };
        setMessages((prevMessages) => [...prevMessages, botResponse]);
        if (data.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
          setSuggestions(data.suggestions);
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

  return (
    <Card className="w-full max-w-md mx-auto flex flex-col h-[700px] rounded-2xl shadow-2xl bg-white/80 backdrop-blur-sm border-0 overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-purple-500 to-indigo-600"></div>
      <CardHeader className="pt-6 pb-4 flex flex-row items-center justify-between bg-transparent">
        <div className="flex items-center space-x-3">
          <Avatar className="w-10 h-10 ring-2 ring-purple-400 ring-offset-2 ring-offset-white">
            <AvatarImage src="https://github.com/shadcn.png" alt="Mia Avatar" />
            <AvatarFallback>M</AvatarFallback>
          </Avatar>
          <CardTitle className="text-lg font-semibold text-gray-800">Talk to Mia</CardTitle>
        </div>
        <div className="flex items-center space-x-4">
            <MessageSquarePlus className="w-5 h-5 text-gray-500 cursor-pointer hover:text-gray-800" />
            <X className="w-5 h-5 text-gray-500 cursor-pointer hover:text-gray-800" />
        </div>
      </CardHeader>
      
      <CardContent className="flex-1 overflow-hidden p-0 flex flex-col">
        <ScrollArea className="h-full p-6">
          <div className="flex flex-col space-y-1">
            {messages.map((message) => (
              <React.Fragment key={message.id}>
              <div
                className={`flex items-end gap-2.5 ${
                  message.sender === "user" ? "justify-end" : "justify-start"
                } mt-3`}
              >
                {message.sender === "bot" && (
                  <Avatar className="w-8 h-8">
                    <AvatarImage src="https://github.com/shadcn.png" alt="Mia Avatar" />
                    <AvatarFallback>M</AvatarFallback>
                  </Avatar>
                )}
                <div
                  className={`p-3 px-4 rounded-2xl max-w-[75%] text-sm font-medium shadow-sm ${
                    message.sender === "user"
                      ? "bg-violet-100 text-gray-900 rounded-br-lg"
                      : "bg-white text-gray-800 rounded-bl-lg"
                  }`}
                >
                  {message.text}
                </div>
              </div>
              {message.sender === 'bot' && message.generatedSql && (
                <div className="flex justify-start">
                    <div className="w-8 h-8 flex-shrink-0"></div>
                    <div className="ml-2.5 w-full max-w-[75%]">
                        <Accordion type="single" collapsible className="w-full">
                            <AccordionItem value="item-1" className="border-none">
                                <AccordionTrigger className="text-xs text-gray-500 hover:no-underline py-1 justify-start gap-1">
                                    <Database className="h-3 w-3" />
                                    Show generated SQL
                                </AccordionTrigger>
                                <AccordionContent className="mt-1 p-2 bg-gray-100 rounded-md">
                                    <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono"><code>{message.generatedSql}</code></pre>
                                </AccordionContent>
                            </AccordionItem>
                        </Accordion>
                    </div>
                </div>
              )}
              </React.Fragment>
            ))}
            {isBotTyping && (
              <div className="flex items-end gap-2.5 justify-start mt-3">
                <Avatar className="w-8 h-8">
                  <AvatarImage src="https://github.com/shadcn.png" alt="Mia Avatar" />
                  <AvatarFallback>M</AvatarFallback>
                </Avatar>
                <div className="p-3 px-4 rounded-2xl bg-white text-gray-800 rounded-bl-lg shadow-sm">
                  <div className="flex items-center justify-center space-x-1.5">
                    <span className="h-2 w-2 bg-gray-300 rounded-full animate-pulse [animation-delay:-0.3s]"></span>
                    <span className="h-2 w-2 bg-gray-300 rounded-full animate-pulse [animation-delay:-0.15s]"></span>
                    <span className="h-2 w-2 bg-gray-300 rounded-full animate-pulse"></span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>
        {suggestions.length > 0 && !isBotTyping && (
          <div className="p-4 pt-2 border-t border-gray-100">
            <div className="flex flex-wrap gap-2">
              {suggestions.map((suggestion, index) => (
                <Button
                  key={index}
                  variant="outline"
                  size="sm"
                  className="rounded-full text-xs h-auto py-1.5 px-3 bg-white/50 hover:bg-gray-200/70 border-gray-300 text-gray-700"
                  onClick={() => sendMessage(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="p-3 border-t border-gray-100 bg-transparent">
        <div className="w-full p-2 bg-white/70 rounded-xl shadow-inner">
            <Textarea
              placeholder="Ask Mia anything..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              className="w-full bg-transparent border-0 resize-none p-2 focus-visible:ring-0 focus-visible:ring-offset-0"
              rows={1}
            />
            <div className="flex justify-between items-center mt-1">
                <div className="flex items-center space-x-1">
                    <Button variant="ghost" size="icon" className="rounded-full w-9 h-9 text-gray-500 hover:bg-gray-200 hover:text-gray-800">
                        <Plus className="w-5 h-5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="rounded-full w-9 h-9 text-gray-500 hover:bg-gray-200 hover:text-gray-800">
                        <Mic className="w-5 h-5" />
                    </Button>
                </div>
                <Button onClick={handleSendMessage} size="icon" className="rounded-full w-10 h-10 p-0 flex items-center justify-center bg-purple-600 hover:bg-purple-700 transition-colors text-white">
                    <SendHorizonal className="h-5 w-5" />
                </Button>
            </div>
        </div>
      </CardFooter>
    </Card>
  );
};

export default Chatbot;