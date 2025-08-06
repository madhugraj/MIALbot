"use client";

import React, { useState, useRef, useEffect } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SendHorizonal, X, Plus, Mic, Database } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { supabase } from "@/integrations/supabase/client";
import PredefinedQuestions from "./PredefinedQuestions";

interface Message {
  id: number;
  text: string;
  sender: "user" | "bot";
  generatedSql?: string | null;
  followUpOptions?: string[];
}

const Chatbot: React.FC = () => {
  const messageIdCounter = useRef(0);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: messageIdCounter.current++,
      text: "Hello! I'm Mia, your flight assistant. How can I help you today?",
      sender: "bot",
    },
  ]);
  const [input, setInput] = useState<string>("");
  const [isBotTyping, setIsBotTyping] = useState<boolean>(false);
  const [lastUserQuestion, setLastUserQuestion] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isBotTyping]);

  const handleSendMessage = async (text: string) => {
    if (text.trim() === "") return;

    const newUserMessage: Message = {
      id: messageIdCounter.current++,
      text,
      sender: "user",
    };
    
    if (newUserMessage.sender === 'user') {
        setLastUserQuestion(text.split(" on ")[0]);
    }

    setMessages(prevMessages => [...prevMessages, newUserMessage]);
    setInput("");
    setIsBotTyping(true);

    try {
      const { data, error } = await supabase.functions.invoke('chatbot-agent', {
        body: { 
          user_query: text,
          history: [...messages, newUserMessage].map(m => ({ text: m.text, sender: m.sender }))
        },
      });

      if (error) {
        throw new Error(`Edge Function Error: ${error.message}`);
      }
      
      const botResponse: Message = {
        id: messageIdCounter.current++,
        text: data.response,
        sender: "bot",
        generatedSql: data.generatedSql,
        followUpOptions: data.requiresFollowUp ? data.followUpOptions : undefined,
      };
      setMessages((prevMessages) => [...prevMessages, botResponse]);

    } catch (e) {
      console.error("Error calling chatbot API:", e);
      const errorText = e instanceof Error ? e.message : "An unknown error occurred.";
      const botErrorResponse: Message = {
        id: messageIdCounter.current++,
        text: `Sorry, I couldn't process your request. ${errorText}`,
        sender: "bot",
      };
      setMessages((prevMessages) => [...prevMessages, botErrorResponse]);
    } finally {
      setIsBotTyping(false);
    }
  };

  const handleFollowUpSelect = (selection: string) => {
    const newQuery = `${lastUserQuestion} on ${selection}`;
    handleSendMessage(newQuery);
  };

  const handleQuestionSelect = (question: string) => {
    setInput(question);
    inputRef.current?.focus();
  };

  return (
    <Card className="w-full max-w-lg mx-auto flex flex-col h-[80vh] max-h-[800px] rounded-2xl shadow-2xl bg-white/80 backdrop-blur-sm border-0 overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-purple-500 to-indigo-600"></div>
      <CardHeader className="pt-6 pb-2 flex flex-row items-center justify-between bg-transparent border-b">
        <div className="flex items-center space-x-3">
          <Avatar className="w-10 h-10 ring-2 ring-purple-400 ring-offset-2 ring-offset-white">
            <AvatarImage src="https://github.com/shadcn.png" alt="Mia Avatar" />
            <AvatarFallback>M</AvatarFallback>
          </Avatar>
          <CardTitle className="text-lg font-semibold text-gray-800">MIA Flight Assistant</CardTitle>
        </div>
        <X className="w-5 h-5 text-gray-500 cursor-pointer hover:text-gray-800" />
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
                  className={`p-3 px-4 rounded-2xl max-w-[85%] text-sm font-medium shadow-sm ${
                    message.sender === "user"
                      ? "bg-violet-100 text-gray-900 rounded-br-lg"
                      : "bg-white text-gray-800 rounded-bl-lg"
                  }`}
                >
                  {message.text}
                </div>
              </div>

              {message.sender === 'bot' && message.followUpOptions && message.followUpOptions.length > 0 && (
                <div className="flex justify-start">
                    <div className="w-8 h-8 flex-shrink-0"></div>
                    <div className="ml-2.5 mt-2 flex flex-wrap gap-2">
                        {message.followUpOptions.map((option, index) => (
                            <Button
                                key={index}
                                variant="outline"
                                size="sm"
                                className="bg-white/80 hover:bg-white"
                                onClick={() => handleFollowUpSelect(option)}
                            >
                                {option}
                            </Button>
                        ))}
                    </div>
                </div>
              )}

              {message.sender === 'bot' && message.generatedSql && (
                <div className="flex justify-start">
                    <div className="w-8 h-8 flex-shrink-0"></div>
                    <div className="ml-2.5 w-full max-w-[85%]">
                        <Accordion type="single" collapsible className="w-full">
                            <AccordionItem value="item-1" className="border-none">
                                <AccordionTrigger className="text-xs text-gray-500 hover:no-underline py-1 justify-start gap-1">
                                    <Database className="h-3 w-3" />
                                    Show technical details
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
      </CardContent>

      <PredefinedQuestions onQuestionSelect={handleQuestionSelect} />

      <CardFooter className="p-3 border-t border-gray-100 bg-transparent">
        <div className="w-full p-2 bg-white/70 rounded-xl shadow-inner">
            <Textarea
              ref={inputRef}
              placeholder="Ask about a flight..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage(input);
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
                <Button onClick={() => handleSendMessage(input)} size="icon" className="rounded-full w-10 h-10 p-0 flex items-center justify-center bg-purple-600 hover:bg-purple-700 transition-colors text-white">
                    <SendHorizonal className="h-5 w-5" />
                </Button>
            </div>
        </div>
      </CardFooter>
    </Card>
  );
};

export default Chatbot;