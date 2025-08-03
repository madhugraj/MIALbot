"use client";

import React, { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Message {
  id: number;
  text: string;
  sender: "user" | "bot";
}

const Chatbot: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState<string>("");

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
    <Card className="w-full max-w-md mx-auto flex flex-col h-[600px]">
      <CardHeader>
        <CardTitle>PostgreSQL Chatbot</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <ScrollArea className="h-full p-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`mb-2 p-2 rounded-lg max-w-[80%] ${
                message.sender === "user"
                  ? "bg-blue-500 text-white ml-auto"
                  : "bg-gray-200 text-gray-800 mr-auto"
              }`}
            >
              {message.text}
            </div>
          ))}
        </ScrollArea>
      </CardContent>
      <CardFooter className="flex p-4 border-t">
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
          className="flex-1 mr-2"
        />
        <Button onClick={handleSendMessage}>Send</Button>
      </CardFooter>
    </Card>
  );
};

export default Chatbot;