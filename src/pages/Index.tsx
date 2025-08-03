import { MadeWithDyad } from "@/components/made-with-dyad";
import Chatbot from "@/components/Chatbot";

const Index = () => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 p-4">
      <div className="flex-grow flex items-center justify-center w-full">
        <Chatbot />
      </div>
      <MadeWithDyad />
    </div>
  );
};

export default Index;