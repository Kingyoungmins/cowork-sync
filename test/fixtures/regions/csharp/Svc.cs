namespace N
{
    public partial class Svc
    {
        public void Reset()
        {
            Log("reset");
        }

        private int _calls;

        public int Calc(int x)
        {
            return x * 2;
        }

        public double Calc(double x)
        {
            return x * 2.0;
        }

        public string Describe()
        {
            _calls++;
            var kind = "svc";
            var text = kind + ":" + _calls;
            return text;
        }

        private static void Log(string message)
        {
            System.Console.WriteLine(message);
        }
    }
}
