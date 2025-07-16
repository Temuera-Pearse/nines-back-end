// File: src/Config/AppSettings.cs
namespace Nines.BackEnd.Config
{
    /// <summary>
    /// Binds to the "AppSettings" section in appsettings.json.
    /// </summary>
    public class AppSettings
    {
        /// <summary>
        /// How many seconds each race should run.
        /// </summary>
        public int DefaultRaceDurationSeconds { get; set; }

        /// <summary>
        /// How long (in seconds) to show results after a race completes.
        /// </summary>
        public int ResultScreenDurationSeconds { get; set; }
    }
}
