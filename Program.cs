// File: Program.cs

using System;
using System.IO;
using System.Reflection;
using Microsoft.AspNetCore.Builder;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

using Nines.BackEnd.Config;               // AppSettings
using Nines.BackEnd.Data;                 // GameDbContext
using Nines.BackEnd.Domains.Repositories; // IRaceRepository, EfRaceRepository
using Nines.BackEnd.Services;             // IRaceService, RaceService, RaceScheduler
using Nines.BackEnd.Gateways;             // IExchangeGateway, ExchangeGateway

var builder = WebApplication.CreateBuilder(args);

// 1️⃣ Bind AppSettings
builder.Services.Configure<AppSettings>(
    builder.Configuration.GetSection("AppSettings"));

// 2️⃣ Register EF Core DbContext
builder.Services.AddDbContext<GameDbContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("GameDatabase"))
);

// 3️⃣ Register Repository → EF implementation
builder.Services.AddScoped<IRaceRepository, EfRaceRepository>();

// 4️⃣ Register your domain Service + Scheduler
builder.Services.AddScoped<IRaceService, RaceService>();
builder.Services.AddHostedService<RaceScheduler>();

// 5️⃣ (Optional) HTTP client for your gateway
builder.Services.AddHttpClient<IExchangeGateway, ExchangeGateway>(client =>
{
    client.Timeout = TimeSpan.FromSeconds(10);
    // client.BaseAddress = new Uri("https://api.example.com/");
});

// 6️⃣ Add MVC controllers
builder.Services.AddControllers();

// 7️⃣ Add Swagger/OpenAPI & XML comments
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(opts =>
{
    var xmlFile = $"{Assembly.GetExecutingAssembly().GetName().Name}.xml";
    var xmlPath = Path.Combine(AppContext.BaseDirectory, xmlFile);
    opts.IncludeXmlComments(xmlPath);
});

var app = builder.Build();

// 8️⃣ Dev‐only middleware: detailed errors + Swagger UI
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
    app.UseSwagger();
    app.UseSwaggerUI();
}

// 9️⃣ Global middleware pipeline
app.UseHttpsRedirection();
app.UseRouting();
app.UseAuthorization();

// 🔟 Map attribute‐decorated controllers
app.MapControllers();

// 1️⃣1️⃣ Start listening for HTTP requests
app.Run();
