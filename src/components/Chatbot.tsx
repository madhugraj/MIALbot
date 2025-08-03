"use client";

import React, { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SendHorizonal } from "lucide-react"; // Added for send icon

interface Message {
  id: number;
  text: string;
  sender: "user" | "bot";
}

const Chatbot: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = () => {
    if (input.trim() === "") return;

    const newUserMessage: Message = {
      id: messages.length + 1,
      text: input,
      sender: "user",
    };
    setMessages((prevMessages) => [...prevMessages, newUserMessage]);
    setInput("");

    // Simulate a bot response (this is where your backend API call would go)
    setTimeout(() => {
      const botResponse: Message = {
        id: messages.length + 2,
        text: `Echo: "${input}". (This would be a response from your PostgreSQL query)`,
        sender: "bot",
      };
      setMessages((prevMessages) => [...prevMessages, botResponse]);
    }, 1000);
  };

  return (
    <Card className="w-full max-w-md mx-auto flex flex-col h-[600px] rounded-xl shadow-lg bg-card text-card-foreground">
      <CardHeader className="border-b p-4">
        <CardTitle className="text-xl font-semibold">PostgreSQL Chatbot</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <ScrollArea className="h-full p-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`mb-3 p-3 rounded-xl max-w-[75%] ${
                message.sender === "user"
                  ? "bg-primary text-primary-foreground ml-auto rounded-br-none"
                  : "bg-muted text-muted-foreground mr-auto rounded-bl-none"
              }`}
            >
              {message.text}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </ScrollArea>
      </CardContent>
      <CardFooter className="flex p-4 border-t bg-background">
        <Input
          type="text"
          placeholder="Type your message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => {
            if (e.key === "Enter") {
              handleSendMessage();
            }
          }}
          className="flex-1 mr-2 rounded-lg focus-visible:ring-ring"
        />
        <Button onClick={handleSendMessage} className="rounded-lg px-4 py-2">
          <SendHorizonal className="h-5 w-5" />
        </Button>
      </CardFooter>
    </Card>
  );
};

export default Chatbot;